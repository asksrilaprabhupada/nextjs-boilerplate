/**
 * search-snapshot.ts - One private compressed object for an owner-authorized run.
 *
 * Ordinary searches never call this module. The object contains the raw
 * question, the private decision trace, and both response forms; the relational
 * row contains metadata and hashes only. Every network call has a deadline and
 * callers must catch failure so snapshot storage can never break search.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createBoundedSupabaseAdmin } from "@/app/lib/01-supabase";
import { searchConfigVersion } from "@/app/lib/search-v2/config";
import type {
  PipelineDiagnostics,
  SearchTelemetry,
} from "@/app/lib/search-v2/pipeline";
import type { SnapshotSession } from "@/app/lib/search-v2/diagnostic-session";

export const SEARCH_SNAPSHOT_BUCKET = "search-answer-snapshots";
export const SEARCH_SNAPSHOT_SCHEMA_VERSION = "search-answer-snapshot-v2";
export const SEARCH_SNAPSHOT_RETENTION_DAYS = 30;
export const SEARCH_SNAPSHOT_MAX_OBJECT_BYTES = 10 * 1024 * 1024;

const STORAGE_REQUEST_TIMEOUT_MS = 4_000;

export interface SearchSnapshotInput {
  session: SnapshotSession;
  searchLogId: string;
  requestId: string;
  question: string;
  telemetry: SearchTelemetry;
  diagnostics: PipelineDiagnostics;
  internalResponse: Record<string, unknown>;
  guardedResponse: Record<string, unknown>;
  /** The exact JSON bytes placed in the JSON body or SSE `result` frame. */
  guardedResponseJson: string;
  capturedAt?: Date;
  environment?: string;
  deploymentSha?: string;
}

export interface SnapshotMetadata {
  search_log_id: string;
  request_id: string;
  capture_id_hash: string;
  environment: "preview";
  deployment_sha: string;
  pipeline_version: string;
  corpus_version: string;
  config_version: string;
  bucket_id: string;
  object_path: string;
  payload_sha256: string;
  payload_bytes: number;
  object_sha256: string;
  object_bytes: number;
  expires_at: string;
}

export interface SearchSnapshotArtifact {
  objectPath: string;
  compressed: Buffer;
  metadata: SnapshotMetadata;
  payloadSha256: string;
  payloadBytes: number;
  objectSha256: string;
  objectBytes: number;
}

export interface SnapshotPersistence {
  upload(path: string, object: Buffer): Promise<void>;
  insert(metadata: SnapshotMetadata): Promise<void>;
  remove(path: string): Promise<void>;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isoDatePath(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

/** Pure builder used by tests and by the live writer. */
export function buildSearchSnapshotArtifact(input: SearchSnapshotInput): SearchSnapshotArtifact {
  const environment = input.environment ?? process.env.VERCEL_ENV ?? "";
  const deploymentSha = input.deploymentSha ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "";
  if (environment !== "preview" || !/^[0-9a-f]{40}$/.test(deploymentSha)) {
    throw new Error("snapshot capture is preview-only and requires an exact deployment SHA");
  }
  if (input.session.questionHash !== input.telemetry.questionHash) {
    throw new Error("snapshot session does not match pipeline question hash");
  }
  if (JSON.stringify(input.guardedResponse) !== input.guardedResponseJson) {
    throw new Error("guarded response bytes were not reused for delivery");
  }

  const capturedAt = input.capturedAt ?? new Date();
  const expiresAt = new Date(
    capturedAt.getTime() + SEARCH_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const payload = {
    schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: capturedAt.toISOString(),
    identifiers: {
      requestId: input.requestId,
      searchLogId: input.searchLogId,
      environment: "preview",
      deploymentSha,
      pipelineVersion: input.telemetry.pipelineVersion,
      corpusVersion: input.telemetry.corpusVersion,
      configVersion: searchConfigVersion(),
    },
    question: input.question,
    telemetry: input.telemetry,
    decisions: input.diagnostics,
    responses: {
      internal: input.internalResponse,
      guarded: input.guardedResponse,
      guardedJson: input.guardedResponseJson,
    },
  };
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const payloadSha256 = sha256(payloadJson);
  const envelope = JSON.stringify({
    envelopeVersion: "search-answer-snapshot-envelope-v2",
    payload,
    payloadIntegrity: {
      algorithm: "sha256",
      sha256: payloadSha256,
      bytes: payloadBytes,
    },
  });
  const compressed = gzipSync(Buffer.from(envelope, "utf8"), { level: 9 });
  if (compressed.byteLength > SEARCH_SNAPSHOT_MAX_OBJECT_BYTES) {
    throw new Error("snapshot object exceeds the private bucket limit");
  }
  const objectSha256 = sha256(compressed);
  // The applied metadata constraint intentionally fixes Storage objects under
  // the v1 path namespace. Payload/signing versions may evolve independently;
  // changing this prefix requires a separately approved forward migration.
  const objectPath = `v1/${isoDatePath(capturedAt)}/${input.session.captureId}.json.gz`;
  const metadata: SnapshotMetadata = {
    search_log_id: input.searchLogId,
    request_id: input.requestId,
    capture_id_hash: input.session.captureIdHash,
    environment: "preview",
    deployment_sha: deploymentSha,
    pipeline_version: input.telemetry.pipelineVersion,
    corpus_version: input.telemetry.corpusVersion,
    config_version: searchConfigVersion(),
    bucket_id: SEARCH_SNAPSHOT_BUCKET,
    object_path: objectPath,
    payload_sha256: payloadSha256,
    payload_bytes: payloadBytes,
    object_sha256: objectSha256,
    object_bytes: compressed.byteLength,
    expires_at: expiresAt.toISOString(),
  };
  return {
    objectPath,
    compressed,
    metadata,
    payloadSha256,
    payloadBytes,
    objectSha256,
    objectBytes: compressed.byteLength,
  };
}

function productionPersistence(): SnapshotPersistence {
  const client = createBoundedSupabaseAdmin(STORAGE_REQUEST_TIMEOUT_MS);
  return {
    async upload(path, object) {
      const { error } = await client.storage
        .from(SEARCH_SNAPSHOT_BUCKET)
        .upload(path, object, {
          cacheControl: "0",
          contentType: "application/gzip",
          upsert: false,
        });
      if (error) throw new Error("snapshot object upload failed");
    },
    async insert(metadata) {
      const { error } = await client.from("search_answer_snapshots").insert(metadata);
      if (error) throw new Error("snapshot metadata insert failed");
    },
    async remove(path) {
      const { error } = await client.storage.from(SEARCH_SNAPSHOT_BUCKET).remove([path]);
      if (error) throw new Error("snapshot compensation failed");
    },
  };
}

/** Upload first, then metadata; compensate through the Storage API on insert failure. */
export async function persistSearchSnapshot(
  input: SearchSnapshotInput,
  persistence: SnapshotPersistence = productionPersistence(),
): Promise<SearchSnapshotArtifact> {
  const artifact = buildSearchSnapshotArtifact(input);
  await persistence.upload(artifact.objectPath, artifact.compressed);
  try {
    await persistence.insert(artifact.metadata);
  } catch (error) {
    try {
      await persistence.remove(artifact.objectPath);
    } catch {
      console.error(JSON.stringify({
        level: "error",
        event: "search.snapshot_compensation_failed",
        requestId: input.requestId,
      }));
    }
    throw error;
  }
  return artifact;
}
