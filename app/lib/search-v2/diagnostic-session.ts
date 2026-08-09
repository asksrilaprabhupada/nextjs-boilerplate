/**
 * diagnostic-session.ts - Preview-only owner authorization for exact snapshots.
 *
 * A browser EventSource cannot attach custom headers. The owner therefore signs
 * one POST that mints a short-lived HttpOnly cookie, bound to the exact question.
 * The cookie carries no question or visitor identity.
 * Ordinary requests have no cookie and cannot enable capture with a query flag.
 */
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { fullSha256, normalizeQuestion } from "@/app/lib/search-v2/cache";
import { PREVIEW_VERIFICATION_SECRET_ENV } from "@/app/lib/search-v2/preview-verification";

export const SNAPSHOT_SESSION_COOKIE = "__Secure-asp_search_snapshot";
export const SNAPSHOT_TIMESTAMP_HEADER = "x-asp-snapshot-timestamp";
export const SNAPSHOT_NONCE_HEADER = "x-asp-snapshot-nonce";
export const SNAPSHOT_SIGNATURE_HEADER = "x-asp-snapshot-signature";

const AUTH_CLOCK_SKEW_SECONDS = 90;
const SESSION_TTL_SECONDS = 5 * 60;

interface HeaderReader {
  get(name: string): string | null;
}

export interface SnapshotRequestLike {
  method: string;
  url: string;
  headers: HeaderReader;
}

export interface SnapshotTarget {
  query: string;
}

export interface SnapshotSession {
  captureId: string;
  captureIdHash: string;
  questionHash: string;
  expiresAt: number;
}

interface SnapshotSessionToken extends SnapshotSession {
  version: "snapshot-session-v2";
}

export interface SnapshotAuthOptions {
  environment?: string;
  secret?: string;
  nowSeconds?: number;
}

export interface SnapshotAuthorization {
  timestamp: string;
  nonce: string;
}

export class SnapshotAuthorizationRejectedError extends Error {
  constructor() {
    super("snapshot authorization rejected");
    this.name = "SnapshotAuthorizationRejectedError";
  }
}

function secretFor(options: SnapshotAuthOptions): string | null {
  const environment = options.environment ?? process.env.VERCEL_ENV;
  const secret = options.secret ?? process.env[PREVIEW_VERIFICATION_SECRET_ENV];
  return environment === "preview" && typeof secret === "string" && secret.length >= 32
    ? secret
    : null;
}

function safeHexEqual(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function targetIdentity(target: SnapshotTarget): { questionHash: string } {
  return {
    questionHash: fullSha256(normalizeQuestion(target.query)),
  };
}

function authorizationPayload(input: {
  request: Pick<SnapshotRequestLike, "method" | "url">;
  target: SnapshotTarget;
  timestamp: string;
  nonce: string;
}): string {
  const url = new URL(input.request.url);
  const identity = targetIdentity(input.target);
  return [
    "snapshot-authorization-v2",
    input.timestamp,
    input.nonce,
    input.request.method.toUpperCase(),
    `${url.origin}${url.pathname}`,
    identity.questionHash,
  ].join("\n");
}

/** Exported for the owner-side helper and deterministic tests. */
export function snapshotAuthorizationSignature(input: {
  request: Pick<SnapshotRequestLike, "method" | "url">;
  target: SnapshotTarget;
  timestamp: string;
  nonce: string;
  secret: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(authorizationPayload(input))
    .digest("hex");
}

/** Authenticates the owner request that asks the server to mint one session. */
export function authorizeSnapshotSession(
  request: SnapshotRequestLike,
  target: SnapshotTarget,
  options: SnapshotAuthOptions = {},
): SnapshotAuthorization {
  const secret = secretFor(options);
  const timestamp = request.headers.get(SNAPSHOT_TIMESTAMP_HEADER) ?? "";
  const nonce = request.headers.get(SNAPSHOT_NONCE_HEADER) ?? "";
  const signature = request.headers.get(SNAPSHOT_SIGNATURE_HEADER) ?? "";
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const parsedTimestamp = /^\d{10}$/.test(timestamp) ? Number(timestamp) : Number.NaN;

  if (
    !secret
    || request.method.toUpperCase() !== "POST"
    || !Number.isSafeInteger(parsedTimestamp)
    || Math.abs(nowSeconds - parsedTimestamp) > AUTH_CLOCK_SKEW_SECONDS
    || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)
  ) {
    throw new SnapshotAuthorizationRejectedError();
  }

  const expected = snapshotAuthorizationSignature({
    request,
    target,
    timestamp,
    nonce,
    secret,
  });
  if (!safeHexEqual(signature, expected)) throw new SnapshotAuthorizationRejectedError();
  return { timestamp, nonce };
}

function signToken(encoded: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`snapshot-session-cookie-v2\n${encoded}`)
    .digest("hex");
}

/** Creates the cookie value after authorizeSnapshotSession has succeeded. */
export function mintSnapshotSession(
  target: SnapshotTarget,
  authorization: SnapshotAuthorization,
  options: SnapshotAuthOptions = {},
): { session: SnapshotSession; token: string } {
  const secret = secretFor(options);
  if (!secret) throw new SnapshotAuthorizationRejectedError();
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const identity = targetIdentity(target);
  // A replay of the same fresh signed POST derives the same capture id. Storage
  // `upsert:false` plus unique metadata constraints therefore still permit at
  // most one snapshot, without a durable nonce/session table.
  const captureHex = createHmac("sha256", secret)
    .update([
      "snapshot-capture-id-v2",
      authorization.timestamp,
      authorization.nonce,
      identity.questionHash,
    ].join("\n"))
    .digest("hex")
    .slice(0, 32);
  const captureId = [
    captureHex.slice(0, 8),
    captureHex.slice(8, 12),
    captureHex.slice(12, 16),
    captureHex.slice(16, 20),
    captureHex.slice(20),
  ].join("-");
  const session: SnapshotSessionToken = {
    version: "snapshot-session-v2",
    captureId,
    captureIdHash: createHash("sha256").update(captureId).digest("hex"),
    questionHash: identity.questionHash,
    expiresAt: nowSeconds + SESSION_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return { session, token: `${encoded}.${signToken(encoded, secret)}` };
}

function cookieValue(headers: HeaderReader): string | null {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  for (const pair of cookie.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === SNAPSHOT_SESSION_COOKIE) {
      return decodeURIComponent(pair.slice(index + 1).trim());
    }
  }
  return null;
}

/**
 * Returns null for ordinary requests. A present but invalid diagnostic cookie
 * is rejected rather than silently becoming an ordinary paid search.
 */
export function readSnapshotSession(
  request: SnapshotRequestLike,
  target: SnapshotTarget,
  options: SnapshotAuthOptions = {},
): SnapshotSession | null {
  const token = cookieValue(request.headers);
  if (token === null) return null;
  const secret = secretFor(options);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const [encoded, signature, extra] = token.split(".");
  if (!secret || !encoded || !signature || extra || !safeHexEqual(signature, signToken(encoded, secret))) {
    throw new SnapshotAuthorizationRejectedError();
  }

  let parsed: SnapshotSessionToken;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SnapshotSessionToken;
  } catch {
    throw new SnapshotAuthorizationRejectedError();
  }
  const identity = targetIdentity(target);
  if (
    parsed.version !== "snapshot-session-v2"
    || !/^[0-9a-f-]{36}$/.test(parsed.captureId)
    || !/^[0-9a-f]{64}$/.test(parsed.captureIdHash)
    || parsed.captureIdHash !== createHash("sha256").update(parsed.captureId).digest("hex")
    || parsed.questionHash !== identity.questionHash
    || !Number.isSafeInteger(parsed.expiresAt)
    || parsed.expiresAt < nowSeconds
    || parsed.expiresAt > nowSeconds + SESSION_TTL_SECONDS
  ) {
    throw new SnapshotAuthorizationRejectedError();
  }
  return parsed;
}

export function snapshotSessionCookie(token: string): string {
  return [
    `${SNAPSHOT_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/api/search",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

/** Clear on the search response so a browser cannot start a second capture. */
export function clearSnapshotSessionCookie(): string {
  return [
    `${SNAPSHOT_SESSION_COOKIE}=`,
    "Path=/api/search",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}
