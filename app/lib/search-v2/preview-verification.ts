/**
 * Preview-only, owner-authorized search verification seam.
 *
 * It can make one retrieval source or all five return a synthetic PostgREST
 * error. No database/provider outage is created, and ordinary requests cannot
 * select a mode: the exact request target is authenticated with a short-lived
 * HMAC using a server-only preview secret.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RpcCapableClient, RpcRequest, RpcResult } from "@/app/lib/search-v2/rpc";

export const PREVIEW_VERIFICATION_HEADER = "x-asp-preview-verification-mode";
export const PREVIEW_VERIFICATION_TIMESTAMP_HEADER = "x-asp-preview-verification-timestamp";
export const PREVIEW_VERIFICATION_NONCE_HEADER = "x-asp-preview-verification-nonce";
export const PREVIEW_VERIFICATION_SIGNATURE_HEADER = "x-asp-preview-verification-signature";
export const PREVIEW_VERIFICATION_SECRET_ENV = "SEARCH_PREVIEW_VERIFICATION_SECRET";

export const PREVIEW_VERIFICATION_MODES = [
  "degrade-transcripts",
  "fail-all-sources",
] as const;

export type PreviewVerificationMode = (typeof PREVIEW_VERIFICATION_MODES)[number];

const RETRIEVAL_FUNCTIONS = new Set([
  "search_transcripts_hybrid_batch_v3",
  "search_verses_hybrid_batch_v3",
  "search_prose_hybrid_batch_v3",
  "search_verse_chunks_hybrid_batch_v3",
  "search_letters_hybrid_batch_v3",
]);
const MAX_CLOCK_SKEW_SECONDS = 90;
const CONTROLLED_ERROR_CODE = "ASP_VERIFY";

interface HeaderReader {
  get(name: string): string | null;
}

export interface VerificationRequestLike {
  method: string;
  url: string;
  headers: HeaderReader;
}

export interface PreviewVerificationOptions {
  environment?: string;
  secret?: string;
  nowSeconds?: number;
}

export class PreviewVerificationRejectedError extends Error {
  constructor() {
    super("preview verification request rejected");
    this.name = "PreviewVerificationRejectedError";
  }
}

function isMode(value: string): value is PreviewVerificationMode {
  return (PREVIEW_VERIFICATION_MODES as readonly string[]).includes(value);
}

function signedPayload(
  request: Pick<VerificationRequestLike, "method" | "url">,
  mode: PreviewVerificationMode,
  timestamp: string,
  nonce: string,
): string {
  const url = new URL(request.url);
  return [
    timestamp,
    nonce,
    mode,
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
  ].join("\n");
}

/** Exported for the owner-side verification command and deterministic tests. */
export function previewVerificationSignature(input: {
  request: Pick<VerificationRequestLike, "method" | "url">;
  mode: PreviewVerificationMode;
  timestamp: string;
  nonce: string;
  secret: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(signedPayload(input.request, input.mode, input.timestamp, input.nonce))
    .digest("hex");
}

/**
 * Returns null for every ordinary request. A request that attempts to use the
 * seam but fails authentication is rejected instead of falling through to a
 * paid search.
 */
export function readPreviewVerificationMode(
  request: VerificationRequestLike,
  options: PreviewVerificationOptions = {},
): PreviewVerificationMode | null {
  const rawMode = request.headers.get(PREVIEW_VERIFICATION_HEADER);
  if (rawMode === null) return null;

  const environment = options.environment ?? process.env.VERCEL_ENV;
  const secret = options.secret ?? process.env[PREVIEW_VERIFICATION_SECRET_ENV];
  const timestamp = request.headers.get(PREVIEW_VERIFICATION_TIMESTAMP_HEADER) ?? "";
  const nonce = request.headers.get(PREVIEW_VERIFICATION_NONCE_HEADER) ?? "";
  const signature = request.headers.get(PREVIEW_VERIFICATION_SIGNATURE_HEADER) ?? "";
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const parsedTimestamp = /^\d{10}$/.test(timestamp) ? Number(timestamp) : Number.NaN;

  if (
    environment !== "preview"
    || typeof secret !== "string"
    || secret.length < 32
    || !isMode(rawMode)
    || !Number.isSafeInteger(parsedTimestamp)
    || Math.abs(nowSeconds - parsedTimestamp) > MAX_CLOCK_SKEW_SECONDS
    || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)
    || !/^[0-9a-f]{64}$/.test(signature)
  ) {
    throw new PreviewVerificationRejectedError();
  }

  const expected = previewVerificationSignature({
    request,
    mode: rawMode,
    timestamp,
    nonce,
    secret,
  });
  const actualBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new PreviewVerificationRejectedError();
  }

  return rawMode;
}

function controlledFailure(): RpcRequest {
  return Promise.resolve<RpcResult>({
    data: null,
    error: { code: CONTROLLED_ERROR_CODE },
  }) as RpcRequest;
}

/** Injects only the selected synthetic retrieval failures; every other RPC is real. */
export function previewVerificationClient<T extends RpcCapableClient>(
  client: T,
  mode: PreviewVerificationMode | null,
): T {
  if (mode === null) return client;

  return new Proxy(client, {
    get(target, property) {
      if (property === "rpc") {
        return (fn: string, args?: Record<string, unknown>) => {
          const fail = mode === "fail-all-sources"
            ? RETRIEVAL_FUNCTIONS.has(fn)
            : fn === "search_transcripts_hybrid_batch_v3";
          return fail ? controlledFailure() : target.rpc(fn, args);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Adds one safe technical marker to the already-minimized telemetry payload. */
export function markPreviewVerification(
  telemetry: Record<string, unknown>,
  mode: PreviewVerificationMode | null,
): Record<string, unknown> {
  return mode === null
    ? telemetry
    : { ...telemetry, verification: { controlled: true, mode } };
}
