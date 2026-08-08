import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";

export const A2_SPEND_LEDGER_SCHEMA_VERSION = "a2-spend-ledger-v1";

const MICRO_USD_PER_USD = 1_000_000;
const TOKENS_PER_COHERE_CHUNK = 500;

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
  voyageSubqueriesPerRow: 5,
  voyageSubqueryUtf8BytesCeiling: 640,
  cohereModel: "rerank-v4.0-pro",
  cohereMaxTokensPerDocument: 4_096,
  cohereSearchUnitDocumentLimit: 100,
  cohereRequestDocumentCeilings: [200, 200, 201, 400] as const,
  cohereTokensPerLongDocumentChunk: TOKENS_PER_COHERE_CHUNK,
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

interface LedgerHeader {
  type: "header";
  schemaVersion: typeof A2_SPEND_LEDGER_SCHEMA_VERSION;
  runId: string;
  definitionSha256: string;
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
  const chunksPerDocument = Math.ceil(
    (A2_BUDGET_DEFINITION.cohereMaxTokensPerDocument + questionUtf8Bytes)
      / TOKENS_PER_COHERE_CHUNK,
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
  const voyageInputBytesCeiling = questionUtf8Bytes
    + A2_BUDGET_DEFINITION.voyageSubqueriesPerRow
      * A2_BUDGET_DEFINITION.voyageSubqueryUtf8BytesCeiling;
  const voyageMicrousd = pricedMicrousd(
    voyageInputBytesCeiling,
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
  ) {}

  static acquire(path: string): A2RunLock {
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx");
    } catch {
      throw new Error(
        "A2 run lock already exists; concurrent or crash recovery needs a fresh owner decision",
      );
    }
    try {
      const body = Buffer.from("A2 paid evaluator lock\n", "utf8");
      writeSync(descriptor, body, 0, body.length);
      fsyncSync(descriptor);
      return new A2RunLock(path, descriptor);
    } catch (error) {
      closeSync(descriptor);
      try { unlinkSync(path); } catch { /* fail closed on the original error */ }
      throw error;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.descriptor);
    unlinkSync(this.path);
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
    readonly maxMicrousd: number,
  ) {}

  static create(
    path: string,
    input: { runId: string; definitionSha256: string; maxMicrousd: number },
  ): A2SpendLedger {
    if (existsSync(path)) throw new Error("A2 spend ledger already exists");
    assertSafeMicrousd(input.maxMicrousd, "A2 maximum spend");
    if (input.maxMicrousd === 0) throw new Error("A2 maximum spend must be positive");
    const header: LedgerHeader = {
      type: "header",
      schemaVersion: A2_SPEND_LEDGER_SCHEMA_VERSION,
      runId: input.runId,
      definitionSha256: input.definitionSha256,
      maxMicrousd: input.maxMicrousd,
    };
    appendDurably(path, header, true);
    return new A2SpendLedger(path, input.runId, input.definitionSha256, input.maxMicrousd);
  }

  static open(
    path: string,
    expected: { runId: string; definitionSha256: string; maxMicrousd: number },
  ): A2SpendLedger {
    const entries = parseLedger(path);
    const header = entries[0];
    if (!header || header.type !== "header"
      || header.schemaVersion !== A2_SPEND_LEDGER_SCHEMA_VERSION
      || header.runId !== expected.runId
      || header.definitionSha256 !== expected.definitionSha256
      || header.maxMicrousd !== expected.maxMicrousd) {
      throw new Error("A2 spend ledger header differs from this approved run");
    }
    const ledger = new A2SpendLedger(
      path,
      header.runId,
      header.definitionSha256,
      header.maxMicrousd,
    );
    for (const entry of entries.slice(1)) ledger.replay(entry);
    return ledger;
  }

  private replay(entry: LedgerEntry): void {
    if (entry.type === "header") throw new Error("A2 spend ledger has more than one header");
    if (typeof entry.rowKey !== "string" || entry.rowKey.length === 0) {
      throw new Error("A2 spend ledger row key is invalid");
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
}
