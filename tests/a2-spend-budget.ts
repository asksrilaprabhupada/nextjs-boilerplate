import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export const A2_SPEND_LEDGER_SCHEMA_VERSION = "a2-spend-ledger-v3";

const MICRO_USD_PER_USD = 1_000_000;
const TOKENS_PER_COHERE_BILLING_CHUNK = 500;

/**
 * These ceilings make the comparison fail closed before a paid row starts.
 * They are deliberately much larger than the observed query-planner and
 * embedding payloads. The ledger later releases only spend proved by complete
 * provider usage metadata; an unknown response keeps its full reservation.
 */
export const A2_BUDGET_DEFINITION = Object.freeze({
  geminiModel: "gemini-2.5-flash",
  geminiInputUsdPerMillionTokens: 0.30,
  geminiOutputUsdPerMillionTokens: 2.50,
  geminiMaxAttemptsPerRow: 2,
  geminiMaxInputTokensPerAttempt: 1_048_576,
  geminiMaxOutputTokensPerAttempt: 1_600,
  voyageModel: "voyage-context-4",
  voyageUsdPerMillionTokensCeiling: 0.18,
  // The contextual-embeddings endpoint permits at most 120K tokens in one
  // request. Reserve that full provider limit: `input_type: "query"` adds a
  // server-side instruction to every input, so raw client bytes alone are not
  // a complete billing ceiling.
  voyageRequestTokenCeiling: 120_000,
  cohereModel: "rerank-v4.0-pro",
  cohereMaxTokensPerDocument: 4_096,
  cohereSearchUnitDocumentLimit: 100,
  cohereRequestDocumentCeilings: [200, 200, 201, 400] as const,
  cohereTokensPerBillingChunk: TOKENS_PER_COHERE_BILLING_CHUNK,
  // Rerank v4 documents use four reserved tokens. Keeping them out of each
  // 500-token billing chunk is conservative even if billing excludes them.
  cohereReservedTokensPerBillingChunk: 4,
});

export interface A2RowBudgetReservation {
  totalMicrousd: number;
  cohereMicrousd: number;
  geminiMicrousd: number;
  voyageMicrousd: number;
  cohereSearchUnitsCeiling: number;
  cohereUsdPerThousandSearchUnits: number;
  questionUtf8Bytes: number;
}

export interface A2KnownRowUsage {
  cohereSearchUnits: number | null;
  geminiAttempts: number | null;
  geminiPromptTokens: number | null;
  geminiOutputTokens: number | null;
  geminiThoughtsTokens: number | null;
  voyageProviderCalls: number | null;
}

export interface A2RowCharge {
  totalMicrousd: number;
  cohereMicrousd: number;
  geminiMicrousd: number;
  voyageMicrousd: number;
  completeUsage: boolean;
}

export interface A2RunLockMetadata {
  schemaVersion: "a2-run-lock-v2";
  runId: string;
  definitionSha256: string;
  lockId: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

interface LedgerHeader {
  type: "header";
  schemaVersion: typeof A2_SPEND_LEDGER_SCHEMA_VERSION;
  runId: string;
  definitionSha256: string;
  manifestSha256: string;
  maxMicrousd: number;
}

interface LedgerReserve {
  type: "reserve";
  rowKey: string;
  reservedMicrousd: number;
}

interface LedgerSettle {
  type: "settle";
  rowKey: string;
  chargedMicrousd: number;
  completeUsage: boolean;
}

type LedgerEntry = LedgerHeader | LedgerReserve | LedgerSettle;

interface LedgerRowState {
  reservedMicrousd: number;
  chargedMicrousd: number | null;
  completeUsage: boolean | null;
}

function assertSafeMicrousd(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

export function usdToMicrousdCeiling(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("USD value must be finite and non-negative");
  const value = Math.ceil(usd * MICRO_USD_PER_USD);
  assertSafeMicrousd(value, "micro-USD value");
  return value;
}

export function microusdToUsd(microusd: number): number {
  assertSafeMicrousd(microusd, "micro-USD value");
  return microusd / MICRO_USD_PER_USD;
}

function pricedMicrousd(tokens: number, usdPerMillionTokens: number): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("token count is invalid");
  return usdToMicrousdCeiling(tokens * usdPerMillionTokens / 1_000_000);
}

export function reserveA2Row(
  question: string,
  cohereUsdPerThousandSearchUnits: number,
): A2RowBudgetReservation {
  if (!Number.isFinite(cohereUsdPerThousandSearchUnits) || cohereUsdPerThousandSearchUnits < 0) {
    throw new Error("Cohere search-unit rate is invalid");
  }
  const questionUtf8Bytes = Buffer.byteLength(question, "utf8");
  // Cohere bills each query plus up-to-100 documents as one search unit while
  // query-document pairs above 500 tokens are split into additional billable
  // chunks. The query is repeated in every chunk. UTF-8 bytes are a safe token
  // ceiling, so reserve document capacity after subtracting the whole query
  // and v4's four reserved tokens from every 500-token chunk.
  const documentTokensPerBillingChunk = TOKENS_PER_COHERE_BILLING_CHUNK
    - questionUtf8Bytes
    - A2_BUDGET_DEFINITION.cohereReservedTokensPerBillingChunk;
  if (documentTokensPerBillingChunk <= 0) {
    throw new Error("A2 question is too long for the conservative Cohere billing ceiling");
  }
  const chunksPerDocument = Math.ceil(
    A2_BUDGET_DEFINITION.cohereMaxTokensPerDocument / documentTokensPerBillingChunk,
  );
  const cohereSearchUnitsCeiling = A2_BUDGET_DEFINITION.cohereRequestDocumentCeilings
    .reduce((total, documentCount) => total + Math.ceil(
      documentCount * chunksPerDocument
        / A2_BUDGET_DEFINITION.cohereSearchUnitDocumentLimit,
    ), 0);
  const cohereMicrousd = usdToMicrousdCeiling(
    cohereSearchUnitsCeiling * cohereUsdPerThousandSearchUnits / 1_000,
  );
  const geminiMicrousd = pricedMicrousd(
    A2_BUDGET_DEFINITION.geminiMaxAttemptsPerRow
      * A2_BUDGET_DEFINITION.geminiMaxInputTokensPerAttempt,
    A2_BUDGET_DEFINITION.geminiInputUsdPerMillionTokens,
  ) + pricedMicrousd(
    A2_BUDGET_DEFINITION.geminiMaxAttemptsPerRow
      * A2_BUDGET_DEFINITION.geminiMaxOutputTokensPerAttempt,
    A2_BUDGET_DEFINITION.geminiOutputUsdPerMillionTokens,
  );
  const voyageMicrousd = pricedMicrousd(
    A2_BUDGET_DEFINITION.voyageRequestTokenCeiling,
    A2_BUDGET_DEFINITION.voyageUsdPerMillionTokensCeiling,
  );
  return {
    totalMicrousd: cohereMicrousd + geminiMicrousd + voyageMicrousd,
    cohereMicrousd,
    geminiMicrousd,
    voyageMicrousd,
    cohereSearchUnitsCeiling,
    cohereUsdPerThousandSearchUnits,
    questionUtf8Bytes,
  };
}

function isKnownCount(value: number | null, minimum = 0): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= minimum;
}

export function chargeA2Row(
  reservation: A2RowBudgetReservation,
  usage: A2KnownRowUsage | null,
): A2RowCharge {
  if (usage === null) {
    return {
      totalMicrousd: reservation.totalMicrousd,
      cohereMicrousd: reservation.cohereMicrousd,
      geminiMicrousd: reservation.geminiMicrousd,
      voyageMicrousd: reservation.voyageMicrousd,
      completeUsage: false,
    };
  }

  const cohereKnown = isKnownCount(usage.cohereSearchUnits);
  const geminiKnown = usage.geminiAttempts === 1
    && isKnownCount(usage.geminiPromptTokens, 1)
    && isKnownCount(usage.geminiOutputTokens, 1)
    && isKnownCount(usage.geminiThoughtsTokens);
  const voyageKnown = isKnownCount(usage.voyageProviderCalls)
    && usage.voyageProviderCalls <= 1;

  const cohereMicrousd = cohereKnown
    ? usdToMicrousdCeiling(
      usage.cohereSearchUnits! * reservation.cohereUsdPerThousandSearchUnits / 1_000,
    )
    : reservation.cohereMicrousd;
  const geminiMicrousd = geminiKnown
    ? pricedMicrousd(
      usage.geminiPromptTokens!,
      A2_BUDGET_DEFINITION.geminiInputUsdPerMillionTokens,
    ) + pricedMicrousd(
      usage.geminiOutputTokens! + usage.geminiThoughtsTokens!,
      A2_BUDGET_DEFINITION.geminiOutputUsdPerMillionTokens,
    )
    : reservation.geminiMicrousd;
  const voyageMicrousd = voyageKnown && usage.voyageProviderCalls === 0
    ? 0
    : reservation.voyageMicrousd;
  const totalMicrousd = cohereMicrousd + geminiMicrousd + voyageMicrousd;
  if (totalMicrousd > reservation.totalMicrousd) {
    throw new Error("A2 provider usage exceeded its pre-call reservation");
  }
  return {
    totalMicrousd,
    cohereMicrousd,
    geminiMicrousd,
    voyageMicrousd,
    completeUsage: cohereKnown && geminiKnown && voyageKnown,
  };
}

export class A2RunLock {
  private released = false;

  private constructor(
    readonly path: string,
    private readonly descriptor: number,
    readonly recovered: boolean,
    readonly recoveredArchivePath: string | null,
  ) {}

  static acquire(
    path: string,
    input: {
      runId: string;
      definitionSha256: string;
      mode: "run" | "recover";
      staleLockApproval?: string;
    },
  ): A2RunLock {
    let recovered = false;
    let recoveredArchivePath: string | null = null;
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx");
    } catch (error) {
      if (!existsSync(path)) throw error;
      const raw = readFileSync(path, "utf8");
      const requiredApproval = staleLockApproval(raw);
      let prior: A2RunLockMetadata;
      try {
        prior = JSON.parse(raw) as A2RunLockMetadata;
      } catch {
        throw new Error("A2 run lock is malformed; manual audit is required");
      }
      if (prior.schemaVersion !== "a2-run-lock-v2"
        || prior.runId !== input.runId
        || prior.definitionSha256 !== input.definitionSha256
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(prior.lockId)
        || !Number.isSafeInteger(prior.pid)
        || prior.pid <= 0
        || typeof prior.hostname !== "string"
        || typeof prior.startedAt !== "string"
        || !Number.isFinite(Date.parse(prior.startedAt))) {
        throw new Error("A2 run lock does not match this run; manual audit is required");
      }
      if (input.mode !== "recover" || input.staleLockApproval !== requiredApproval) {
        throw new Error(
          `A2 run lock already exists; use recovery-only mode with ${requiredApproval}`,
        );
      }
      if (prior.hostname !== hostname()) {
        throw new Error("A2 run lock belongs to another host; automatic recovery is refused");
      }
      if (processIsAlive(prior.pid)) {
        throw new Error("A2 run lock owner is still alive; recovery is refused");
      }
      recoveredArchivePath = `${path}.recovered-${prior.lockId}`;
      if (existsSync(recoveredArchivePath)) {
        throw new Error("A2 recovered-lock archive already exists; manual audit is required");
      }
      renameSync(path, recoveredArchivePath);
      recovered = true;
      try {
        descriptor = openSync(path, "wx");
      } catch (recoveryError) {
        try { renameSync(recoveredArchivePath, path); } catch { /* preserve both clues */ }
        throw recoveryError;
      }
    }
    try {
      const metadata: A2RunLockMetadata = {
        schemaVersion: "a2-run-lock-v2",
        runId: input.runId,
        definitionSha256: input.definitionSha256,
        lockId: randomUUID(),
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
      };
      const body = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
      let written = 0;
      while (written < body.length) {
        written += writeSync(descriptor, body, written, body.length - written);
      }
      fsyncSync(descriptor);
      return new A2RunLock(path, descriptor, recovered, recoveredArchivePath);
    } catch (error) {
      closeSync(descriptor);
      try { unlinkSync(path); } catch { /* fail closed on the original error */ }
      if (recoveredArchivePath) {
        try { renameSync(recoveredArchivePath, path); } catch { /* manual audit remains fail closed */ }
      }
      throw error;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.descriptor);
    unlinkSync(this.path);
  }

  retainForRecovery(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.descriptor);
  }

  restoreRecoveredLock(): void {
    if (this.released) return;
    if (!this.recovered || !this.recoveredArchivePath) {
      throw new Error("A2 cannot restore a lock that was not recovered");
    }
    this.released = true;
    closeSync(this.descriptor);
    unlinkSync(this.path);
    renameSync(this.recoveredArchivePath, this.path);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export function staleLockApproval(rawLock: string): string {
  const digest = createHash("sha256").update(rawLock).digest("hex");
  return `I_APPROVE_STALE_LOCK_RECOVERY:${digest}`;
}

export function a2RetryApproval(retryManifest: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(retryManifest))
    .digest("hex");
  return `I_APPROVE_PAID_A2_RETRY:${digest}`;
}

export function writeJsonDurably(path: string, value: unknown, exclusive = false): void {
  if (exclusive && existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx");
    let written = 0;
    while (written < body.length) {
      written += writeSync(descriptor, body, written, body.length - written);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (exclusive && existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
    renameSync(temporaryPath, path);
    // Reopen and parse the target so a successful return proves a complete JSON
    // generation is now visible at the final path.
    JSON.parse(readFileSync(path, "utf8"));
    try {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch {
      // Windows can reject directory handles. The file itself is already fsynced.
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) {
      try { unlinkSync(temporaryPath); } catch { /* retain the original failure */ }
    }
  }
}

function appendDurably(path: string, entry: LedgerEntry, exclusive = false): void {
  const descriptor = openSync(path, exclusive ? "wx" : "a");
  try {
    const body = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    let written = 0;
    while (written < body.length) {
      written += writeSync(descriptor, body, written, body.length - written);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parseLedger(path: string): LedgerEntry[] {
  const body = readFileSync(path, "utf8");
  if (!body.endsWith("\n")) throw new Error("A2 spend ledger has a partial final entry");
  return body.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as LedgerEntry;
    } catch {
      throw new Error(`A2 spend ledger entry ${index + 1} is invalid JSON`);
    }
  });
}

export class A2SpendLedger {
  private readonly rows = new Map<string, LedgerRowState>();

  private constructor(
    readonly path: string,
    readonly runId: string,
    readonly definitionSha256: string,
    readonly manifestSha256: string,
    readonly maxMicrousd: number,
  ) {}

  static create(
    path: string,
    input: {
      runId: string;
      definitionSha256: string;
      manifestSha256: string;
      maxMicrousd: number;
    },
  ): A2SpendLedger {
    if (existsSync(path)) throw new Error("A2 spend ledger already exists");
    assertSafeMicrousd(input.maxMicrousd, "A2 maximum spend");
    if (input.maxMicrousd === 0) throw new Error("A2 maximum spend must be positive");
    const header: LedgerHeader = {
      type: "header",
      schemaVersion: A2_SPEND_LEDGER_SCHEMA_VERSION,
      runId: input.runId,
      definitionSha256: input.definitionSha256,
      manifestSha256: input.manifestSha256,
      maxMicrousd: input.maxMicrousd,
    };
    appendDurably(path, header, true);
    return new A2SpendLedger(
      path,
      input.runId,
      input.definitionSha256,
      input.manifestSha256,
      input.maxMicrousd,
    );
  }

  static open(
    path: string,
    expected: {
      runId: string;
      definitionSha256: string;
      manifestSha256: string;
      maxMicrousd: number;
    },
  ): A2SpendLedger {
    const entries = parseLedger(path);
    const header = entries[0];
    if (!header || header.type !== "header"
      || header.schemaVersion !== A2_SPEND_LEDGER_SCHEMA_VERSION
      || header.runId !== expected.runId
      || header.definitionSha256 !== expected.definitionSha256
      || header.manifestSha256 !== expected.manifestSha256
      || header.maxMicrousd !== expected.maxMicrousd) {
      throw new Error("A2 spend ledger header differs from this approved run");
    }
    const ledger = new A2SpendLedger(
      path,
      header.runId,
      header.definitionSha256,
      header.manifestSha256,
      header.maxMicrousd,
    );
    for (const entry of entries.slice(1)) ledger.replay(entry);
    return ledger;
  }

  private replay(entry: LedgerEntry): void {
    if (entry.type === "header") throw new Error("A2 spend ledger has more than one header");
    if (typeof entry.rowKey !== "string" || !/^.+:[1-9]\d*@[1-9]\d*$/u.test(entry.rowKey)) {
      throw new Error("A2 spend ledger attempt key is invalid");
    }
    if (entry.type === "reserve") {
      assertSafeMicrousd(entry.reservedMicrousd, "A2 row reservation");
      if (entry.reservedMicrousd === 0 || this.rows.has(entry.rowKey)) {
        throw new Error(`A2 spend ledger has a duplicate or empty reservation: ${entry.rowKey}`);
      }
      this.rows.set(entry.rowKey, {
        reservedMicrousd: entry.reservedMicrousd,
        chargedMicrousd: null,
        completeUsage: null,
      });
    } else if (entry.type === "settle") {
      assertSafeMicrousd(entry.chargedMicrousd, "A2 row charge");
      const row = this.rows.get(entry.rowKey);
      if (!row || row.chargedMicrousd !== null || entry.chargedMicrousd > row.reservedMicrousd) {
        throw new Error(`A2 spend ledger settlement is invalid: ${entry.rowKey}`);
      }
      row.chargedMicrousd = entry.chargedMicrousd;
      row.completeUsage = entry.completeUsage;
    } else {
      throw new Error("A2 spend ledger has an unknown entry type");
    }
    if (this.committedMicrousd() > this.maxMicrousd) {
      throw new Error("A2 spend ledger exceeds its approved maximum");
    }
  }

  reserve(rowKey: string, reservedMicrousd: number): void {
    assertSafeMicrousd(reservedMicrousd, "A2 row reservation");
    if (reservedMicrousd === 0) throw new Error("A2 row reservation must be positive");
    if (!/^.+:[1-9]\d*@[1-9]\d*$/u.test(rowKey)) {
      throw new Error("A2 spend ledger attempt key is invalid");
    }
    if (this.rows.has(rowKey)) throw new Error(`A2 paid row already has a ledger entry: ${rowKey}`);
    if (this.committedMicrousd() + reservedMicrousd > this.maxMicrousd) {
      throw new Error("A2 stopped before the next paid row because its reservation would exceed the approved maximum");
    }
    const entry: LedgerReserve = { type: "reserve", rowKey, reservedMicrousd };
    appendDurably(this.path, entry);
    this.replay(entry);
  }

  settle(rowKey: string, charge: A2RowCharge): void {
    const row = this.rows.get(rowKey);
    if (!row || row.chargedMicrousd !== null) {
      throw new Error(`A2 paid row cannot be settled: ${rowKey}`);
    }
    assertSafeMicrousd(charge.totalMicrousd, "A2 row charge");
    if (charge.totalMicrousd > row.reservedMicrousd) {
      throw new Error(`A2 row charge exceeds its reservation: ${rowKey}`);
    }
    const entry: LedgerSettle = {
      type: "settle",
      rowKey,
      chargedMicrousd: charge.totalMicrousd,
      completeUsage: charge.completeUsage,
    };
    appendDurably(this.path, entry);
    this.replay(entry);
  }

  committedMicrousd(): number {
    return [...this.rows.values()].reduce(
      (total, row) => total + (row.chargedMicrousd ?? row.reservedMicrousd),
      0,
    );
  }

  openRowKeys(): string[] {
    return [...this.rows.entries()]
      .filter(([, row]) => row.chargedMicrousd === null)
      .map(([rowKey]) => rowKey);
  }

  rowKeys(): string[] {
    return [...this.rows.keys()];
  }

  hasRow(rowKey: string): boolean {
    return this.rows.has(rowKey);
  }

  rowState(rowKey: string): Readonly<LedgerRowState> | null {
    return this.rows.get(rowKey) ?? null;
  }

  sha256(): string {
    return createHash("sha256").update(readFileSync(this.path)).digest("hex");
  }
}
