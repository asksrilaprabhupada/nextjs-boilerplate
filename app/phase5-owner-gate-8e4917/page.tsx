import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { GET as runSearch } from "@/app/api/search/route";
import { POST as mintDiagnosticSession } from "@/app/api/search/diagnostic-session/route";
import {
  ARTICLE_PLANNER_MAX_OUTPUT_TOKENS,
  ARTICLE_PLANNER_THINKING_BUDGET,
  ArticlePlanSchema,
  DISCLOSURE,
  articleRejections,
  planArticle,
} from "@/app/lib/search-v2/article-plan";
import { snapshotAuthorizationSignature } from "@/app/lib/search-v2/diagnostic-session";
import type { VerifiedPassage } from "@/app/lib/search-v2/refetch";
import inventory from "./inventory.json";

export const runtime = "nodejs";
// Temporary Preview-only owner verification endpoint; removed after the gates run.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BUCKET = "search-answer-snapshots";
const FILE_SIZE_LIMIT = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ["application/gzip"];
const MODEL = "gemini-2.5-flash";
const QUESTION = "how to control the mind";

function rejectionCode(reason: string): string {
  if (reason.includes("never supplied")) return "invented_id";
  if (reason.includes("repeats across sections")) return "duplicate_section_id";
  if (reason.includes("lacks verified recipient/date")) return "letter_context";
  if (reason.includes("chronological_development")) return "chronology";
  if (reason.includes("evidence_insufficient")) return "evidence_insufficient";
  if (reason.includes("unsupported or promotional")) return "unsupported_title";
  if (reason.includes("unsupported claim")) return "unsupported_subject";
  if (reason.includes("reads as prose")) return "prose_subject";
  if (reason.includes("opening claims")) return "opening_missing_id";
  return "semantic_other";
}

async function provisionBucket() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("supabase_env_absent");
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const { data: before, error: readError } = await client.storage.getBucket(BUCKET);
  if (readError && !/not found/i.test(readError.message || "")) throw new Error("bucket_audit_failed");
  let created = false;
  if (!before) {
    const { error } = await client.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: FILE_SIZE_LIMIT,
      allowedMimeTypes: ALLOWED_MIME_TYPES,
    });
    if (error) throw new Error("bucket_create_failed");
    created = true;
  }
  const { data: after, error: verifyError } = await client.storage.getBucket(BUCKET);
  if (verifyError || !after) throw new Error("bucket_verify_failed");
  const mimeTypes = [...(after.allowed_mime_types ?? [])].sort();
  const valid = after.public === false
    && Number(after.file_size_limit) === FILE_SIZE_LIMIT
    && JSON.stringify(mimeTypes) === JSON.stringify([...ALLOWED_MIME_TYPES].sort());
  if (!valid) throw new Error("bucket_config_mismatch");
  return {
    bucket: BUCKET,
    created,
    private: true,
    fileSizeLimit: Number(after.file_size_limit),
    allowedMimeTypes: mimeTypes,
  };
}

async function captureProductionArgs(passages: VerifiedPassage[]): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | null = null;
  const first = passages[0].passageKey;
  const fakePlan = JSON.stringify({
    schema_version: "article-plan-v1",
    article_type: "guided_study",
    title: "Controlling the Mind: Source Guide",
    opening: { kind: "direct_source", passage_id: first },
    direct_answer_passage_ids: [first],
    sections: [{
      heading_key: "foundation",
      short_subject: "mind control",
      passage_ids: [first],
      transition_type: "none",
    }],
    closing: { kind: "none", passage_ids: [] },
    disclosure: DISCLOSURE,
  });
  const client = {
    models: {
      async generateContent(args: Record<string, unknown>) {
        captured = args;
        return { text: fakePlan };
      },
    },
  };
  const result = await planArticle(QUESTION, passages, { client, timeoutMs: 60_000 });
  if (!result.plan || !captured) throw new Error("production_args_capture_failed");
  return captured;
}

async function runProbe() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("gemini_env_absent");
  const passages = inventory.map((passage) => ({
    ...passage,
    rowId: passage.passageKey.split(":", 2)[1] ?? passage.passageKey,
    speaker: null,
    speakerConfidence: null,
    vedabaseUrl: null,
    sanskrit: null,
    transliteration: null,
    synonyms: null,
    purport: null,
    scripture: null,
    division: null,
    chapterNumber: null,
    selection: {} as VerifiedPassage["selection"],
  })) as VerifiedPassage[];
  if (passages.length !== 20) throw new Error(`live_inventory_count_${passages.length}`);
  const args = await captureProductionArgs(passages);
  const config = { ...((args.config ?? {}) as Record<string, unknown>),
    thinkingConfig: { thinkingBudget: ARTICLE_PLANNER_THINKING_BUDGET },
    maxOutputTokens: ARTICLE_PLANNER_MAX_OUTPUT_TOKENS,
  };
  const exactArgs = { ...args, model: MODEL, config };
  const client = new GoogleGenAI({ apiKey: key });
  const runs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now();
    const response = await client.models.generateContent(exactArgs as never);
    const wallMs = Math.round(performance.now() - started);
    const text = response.text ?? "";
    let schemaValid = false;
    let semanticAccepted = false;
    let rejectionCodes: string[] = [];
    let placedPassages: number | null = null;
    let distinctPassages: number | null = null;
    try {
      const parsed = ArticlePlanSchema.safeParse(JSON.parse(text));
      schemaValid = parsed.success;
      if (parsed.success) {
        const rejections = articleRejections({ plan: parsed.data, passages, question: QUESTION });
        rejectionCodes = [...new Set(rejections.map(rejectionCode))];
        semanticAccepted = rejections.length === 0;
        const ids = [
          ...(parsed.data.opening.passage_id ? [parsed.data.opening.passage_id] : []),
          ...parsed.data.direct_answer_passage_ids,
          ...parsed.data.sections.flatMap((section) => section.passage_ids),
          ...parsed.data.closing.passage_ids,
        ];
        placedPassages = ids.length;
        distinctPassages = new Set(ids).size;
      } else {
        rejectionCodes = ["schema_invalid"];
      }
    } catch {
      rejectionCodes = ["json_invalid"];
    }
    const raw = response as unknown as {
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
      };
      candidates?: Array<{ finishReason?: string }>;
    };
    runs.push({
      run: i + 1,
      wallMs,
      finishReason: raw.candidates?.[0]?.finishReason ?? null,
      promptTokens: raw.usageMetadata?.promptTokenCount ?? null,
      candidateTokens: raw.usageMetadata?.candidatesTokenCount ?? null,
      thoughtTokens: raw.usageMetadata?.thoughtsTokenCount ?? null,
      totalTokens: raw.usageMetadata?.totalTokenCount ?? null,
      outputBytes: Buffer.byteLength(text, "utf8"),
      schemaValid,
      semanticAccepted,
      rejectionCodes,
      placedPassages,
      distinctPassages,
    });
  }
  const times = runs.map((run) => Number(run.wallMs)).sort((a, b) => a - b);
  return {
    model: MODEL,
    thinkingBudget: ARTICLE_PLANNER_THINKING_BUDGET,
    maxOutputTokens: ARTICLE_PLANNER_MAX_OUTPUT_TOKENS,
    inventoryCount: passages.length,
    inventoryRequestIdPresent: true,
    retries: 0,
    abort: false,
    runs,
    medianMs: times[1],
    schemaAccepted: runs.filter((run) => run.schemaValid).length,
    semanticAccepted: runs.filter((run) => run.semanticAccepted).length,
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runSnapshotGate() {
  const secret = process.env.SEARCH_PREVIEW_VERIFICATION_SECRET ?? "";
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const deploymentSha = process.env.VERCEL_GIT_COMMIT_SHA ?? "";
  const deploymentHost = process.env.VERCEL_URL ?? "preview.invalid";
  if (secret.length < 32 || !supabaseUrl || !serviceKey || !/^[0-9a-f]{40}$/.test(deploymentSha)) {
    throw new Error("snapshot_gate_env_absent");
  }
  const site = `https://${deploymentHost}`;
  const target = { query: QUESTION, speakerOnly: false };
  const sessionUrl = `${site}/api/search/diagnostic-session`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  const signature = snapshotAuthorizationSignature({
    request: { method: "POST", url: sessionUrl },
    target,
    timestamp,
    nonce,
    secret,
  });
  const sessionRequest = new Request(sessionUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-asp-snapshot-timestamp": timestamp,
      "x-asp-snapshot-nonce": nonce,
      "x-asp-snapshot-signature": signature,
    },
    body: JSON.stringify({ q: QUESTION, onlyHis: false }),
  });
  const sessionResponse = await mintDiagnosticSession(sessionRequest as never);
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  if (sessionResponse.status !== 204 || !cookie.startsWith("__Secure-asp_search_snapshot=")) {
    throw new Error(`snapshot_session_http_${sessionResponse.status}`);
  }

  const searchUrl = `${site}/api/search?q=${encodeURIComponent(QUESTION)}&only_his=0`;
  const authorizedResponse = await runSearch(new Request(`${searchUrl}&stream=1`, {
    headers: { cookie },
  }) as never);
  const sse = await authorizedResponse.text();
  let event = "";
  let authorizedResult: Record<string, unknown> | null = null;
  for (const line of sse.split(/\r?\n/)) {
    if (line.startsWith("event: ")) event = line.slice(7);
    if (line.startsWith("data: ") && event === "result") {
      authorizedResult = JSON.parse(line.slice(6)) as Record<string, unknown>;
    }
    if (line.startsWith("data: ") && event === "failure") throw new Error("authorized_search_failure");
  }
  const authorizedRequestId = authorizedResult?.requestId;
  if (typeof authorizedRequestId !== "string") throw new Error("authorized_result_absent");

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const { data: rows, error: rowError } = await client
    .from("search_answer_snapshots")
    .select("request_id,environment,deployment_sha,bucket_id,object_path,payload_sha256,payload_bytes,object_sha256,object_bytes")
    .eq("request_id", authorizedRequestId);
  if (rowError || rows?.length !== 1) throw new Error("authorized_snapshot_count");
  const metadata = rows[0];
  const { data: object, error: objectError } = await client.storage
    .from(metadata.bucket_id)
    .download(metadata.object_path);
  if (objectError || !object) throw new Error("snapshot_object_download");
  const compressed = Buffer.from(await object.arrayBuffer());
  const envelope = JSON.parse(gunzipSync(compressed).toString("utf8")) as {
    payload: { responses: { guarded: unknown; guardedJson: string } };
    payloadIntegrity: { bytes: number; sha256: string };
  };
  const payloadJson = JSON.stringify(envelope.payload);
  const guardedJson = JSON.stringify(authorizedResult);
  const valid = metadata.environment === "preview"
    && metadata.deployment_sha === deploymentSha
    && metadata.object_bytes === compressed.byteLength
    && metadata.object_sha256 === sha256(compressed)
    && metadata.payload_bytes === Buffer.byteLength(payloadJson, "utf8")
    && metadata.payload_sha256 === sha256(payloadJson)
    && envelope.payloadIntegrity.bytes === metadata.payload_bytes
    && envelope.payloadIntegrity.sha256 === metadata.payload_sha256
    && envelope.payload.responses.guardedJson === guardedJson
    && JSON.stringify(envelope.payload.responses.guarded) === guardedJson;
  if (!valid) throw new Error("snapshot_integrity_mismatch");

  const ordinaryResponse = await runSearch(new Request(searchUrl) as never);
  const ordinaryResult = await ordinaryResponse.json() as Record<string, unknown>;
  const ordinaryRequestId = ordinaryResult.requestId;
  if (!ordinaryResponse.ok || typeof ordinaryRequestId !== "string") {
    throw new Error(`ordinary_search_http_${ordinaryResponse.status}`);
  }
  const { count: ordinarySnapshotCount, error: ordinaryError } = await client
    .from("search_answer_snapshots")
    .select("id", { count: "exact", head: true })
    .eq("request_id", ordinaryRequestId);
  if (ordinaryError || ordinarySnapshotCount !== 0) throw new Error("ordinary_snapshot_count");

  return {
    previewSha: deploymentSha,
    authorizedRequestId,
    ordinaryRequestId,
    authorizedSnapshotCount: rows.length,
    ordinarySnapshotCount,
    objectSha256: metadata.object_sha256,
    objectBytes: metadata.object_bytes,
    guardedResponseMatched: true,
  };
}

export default async function Phase5OwnerGatePage({
  searchParams,
}: {
  searchParams: Promise<{ op?: string }>;
}) {
  if (process.env.VERCEL_ENV !== "preview") return <main>Not found</main>;
  const { op } = await searchParams;
  try {
    const result = op === "bucket"
      ? await provisionBucket()
      : op === "probe"
        ? await runProbe()
        : op === "snapshot"
          ? await runSnapshotGate()
        : { error: "not_found" };
    return <main><pre id="result">{JSON.stringify(result)}</pre></main>;
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "phase5_owner_gate_failed",
      op,
      code: error instanceof Error ? error.message : "unknown",
    }));
    return <main><pre id="result">{JSON.stringify({ error: "operation_failed" })}</pre></main>;
  }
}
