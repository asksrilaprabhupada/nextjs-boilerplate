#!/usr/bin/env node
/**
 * Phase 5 deployed gate: one authorized SSE search, one ordinary JSON search.
 *
 * Requires SITE (exact preview URL), EXPECTED_SHA, QUERY,
 * SEARCH_PREVIEW_VERIFICATION_SECRET, SUPABASE_URL, and SUPABASE_SERVICE_KEY.
 * It prints identifiers/hashes/counts only, never the question or snapshot body.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";

const site = String(process.env.SITE || "").replace(/\/$/, "");
const expectedSha = String(process.env.EXPECTED_SHA || "");
const query = String(process.env.QUERY || "").trim();
const onlyHis = process.env.ONLY_HIS === "1";
const secret = String(process.env.SEARCH_PREVIEW_VERIFICATION_SECRET || "");
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (
  !/^https:\/\//.test(site)
  || /https:\/\/asksrilaprabhupada\.vercel\.app$/i.test(site)
  || !/^[0-9a-f]{40}$/.test(expectedSha)
  || !query
  || secret.length < 32
  || !supabaseUrl
  || !serviceKey
) {
  console.error("Snapshot gate requires an exact non-production SITE, EXPECTED_SHA, QUERY, preview secret, and Supabase server credentials.");
  process.exit(2);
}

const normalizeQuestion = (value) => value.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const questionHash = sha256(normalizeQuestion(query));
const speakerFilter = onlyHis ? "prabhupada_segments" : "all";
const sessionUrl = `${site}/api/search/diagnostic-session`;
const sessionTarget = new URL(sessionUrl);
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(18).toString("base64url");
const signaturePayload = [
  "snapshot-authorization-v1",
  timestamp,
  nonce,
  "POST",
  `${sessionTarget.origin}/api/search/diagnostic-session`,
  questionHash,
  speakerFilter,
].join("\n");
const signature = createHmac("sha256", secret).update(signaturePayload).digest("hex");

const sessionResponse = await fetch(sessionUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-asp-snapshot-timestamp": timestamp,
    "x-asp-snapshot-nonce": nonce,
    "x-asp-snapshot-signature": signature,
  },
  body: JSON.stringify({ q: query, onlyHis }),
  signal: AbortSignal.timeout(30_000),
});
const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0] || "";
if (sessionResponse.status !== 204 || !cookie.startsWith("__Secure-asp_search_snapshot=")) {
  console.error(`Snapshot session failed with HTTP ${sessionResponse.status}.`);
  process.exit(1);
}

const target = `${site}/api/search?q=${encodeURIComponent(query)}&only_his=${onlyHis ? "1" : "0"}`;
const authorizedResponse = await fetch(`${target}&stream=1`, {
  headers: { cookie },
  signal: AbortSignal.timeout(300_000),
});
const sse = await authorizedResponse.text();
if (!authorizedResponse.ok) {
  console.error(`Authorized search failed with HTTP ${authorizedResponse.status}.`);
  process.exit(1);
}
let event = "";
let authorizedResult = null;
for (const line of sse.split(/\r?\n/)) {
  if (line.startsWith("event: ")) event = line.slice(7);
  if (line.startsWith("data: ") && event === "result") {
    authorizedResult = JSON.parse(line.slice(6));
  }
  if (line.startsWith("data: ") && event === "failure") {
    console.error("Authorized search returned a controlled public failure.");
    process.exit(1);
  }
}
if (!authorizedResult?.requestId) {
  console.error("Authorized SSE response did not contain one result event.");
  process.exit(1);
}

const client = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const { data: snapshotRows, error: snapshotError } = await client
  .from("search_answer_snapshots")
  .select("request_id,environment,deployment_sha,bucket_id,object_path,payload_sha256,payload_bytes,object_sha256,object_bytes")
  .eq("request_id", authorizedResult.requestId);
if (snapshotError || snapshotRows?.length !== 1) {
  console.error("Authorized search did not create exactly one snapshot metadata row.");
  process.exit(1);
}
const metadata = snapshotRows[0];
const { data: object, error: downloadError } = await client.storage
  .from(metadata.bucket_id)
  .download(metadata.object_path);
if (downloadError || !object) {
  console.error("Private snapshot object could not be downloaded by the server role.");
  process.exit(1);
}
const compressed = Buffer.from(await object.arrayBuffer());
const envelope = JSON.parse(gunzipSync(compressed).toString("utf8"));
const payloadJson = JSON.stringify(envelope.payload);
const expectedGuardedJson = JSON.stringify(authorizedResult);
const snapshotValid = metadata.environment === "preview"
  && metadata.deployment_sha === expectedSha
  && metadata.object_bytes === compressed.byteLength
  && metadata.object_sha256 === sha256(compressed)
  && metadata.payload_bytes === Buffer.byteLength(payloadJson, "utf8")
  && metadata.payload_sha256 === sha256(payloadJson)
  && envelope.payloadIntegrity.bytes === metadata.payload_bytes
  && envelope.payloadIntegrity.sha256 === metadata.payload_sha256
  && envelope.payload.responses.guardedJson === expectedGuardedJson
  && JSON.stringify(envelope.payload.responses.guarded) === expectedGuardedJson;
if (!snapshotValid) {
  console.error("Snapshot hashes, deployment identity, or guarded response reproduction did not match.");
  process.exit(1);
}

const ordinaryResponse = await fetch(target, { signal: AbortSignal.timeout(300_000) });
const ordinaryResult = await ordinaryResponse.json();
if (!ordinaryResponse.ok || !ordinaryResult?.requestId) {
  console.error(`Ordinary search failed with HTTP ${ordinaryResponse.status}.`);
  process.exit(1);
}
const { count: ordinarySnapshotCount, error: ordinarySnapshotError } = await client
  .from("search_answer_snapshots")
  .select("id", { count: "exact", head: true })
  .eq("request_id", ordinaryResult.requestId);
if (ordinarySnapshotError || ordinarySnapshotCount !== 0) {
  console.error("Ordinary search created snapshot metadata.");
  process.exit(1);
}

console.log(JSON.stringify({
  previewSha: expectedSha,
  authorizedRequestId: authorizedResult.requestId,
  ordinaryRequestId: ordinaryResult.requestId,
  authorizedSnapshotCount: snapshotRows.length,
  ordinarySnapshotCount,
  objectSha256: metadata.object_sha256,
  objectBytes: metadata.object_bytes,
  guardedResponseMatched: true,
}, null, 2));
