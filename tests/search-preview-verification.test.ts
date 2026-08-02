import { describe, expect, it, vi } from "vitest";
import {
  PREVIEW_VERIFICATION_HEADER,
  PREVIEW_VERIFICATION_NONCE_HEADER,
  PREVIEW_VERIFICATION_SIGNATURE_HEADER,
  PREVIEW_VERIFICATION_TIMESTAMP_HEADER,
  PreviewVerificationRejectedError,
  previewVerificationClient,
  previewVerificationSignature,
  readPreviewVerificationMode,
} from "@/app/lib/search-v2/preview-verification";
import type { RpcCapableClient, RpcResult } from "@/app/lib/search-v2/rpc";

const secret = "0123456789abcdef0123456789abcdef";
const timestamp = "1785686400";
const nonce = "verification-nonce-0001";
const url = "https://preview.example/api/search?only_his=0&q=control%20the%20mind";

function signedRequest(
  mode: "degrade-transcripts" | "fail-all-sources",
  signatureSecret = secret,
) {
  const request = { method: "GET", url };
  const signature = previewVerificationSignature({
    request,
    mode,
    timestamp,
    nonce,
    secret: signatureSecret,
  });
  const headers = new Headers({
    [PREVIEW_VERIFICATION_HEADER]: mode,
    [PREVIEW_VERIFICATION_TIMESTAMP_HEADER]: timestamp,
    [PREVIEW_VERIFICATION_NONCE_HEADER]: nonce,
    [PREVIEW_VERIFICATION_SIGNATURE_HEADER]: signature,
  });
  return { ...request, headers };
}

describe("preview verification authorization", () => {
  it("does nothing for an ordinary request", () => {
    expect(readPreviewVerificationMode({
      method: "GET",
      url,
      headers: new Headers(),
    }, { environment: "production", secret: "" })).toBeNull();
  });

  it("accepts a fresh exact-target signature only in preview", () => {
    expect(readPreviewVerificationMode(signedRequest("degrade-transcripts"), {
      environment: "preview",
      secret,
      nowSeconds: Number(timestamp),
    })).toBe("degrade-transcripts");
  });

  it("rejects production, stale, modified, or incorrectly signed attempts", () => {
    const valid = signedRequest("fail-all-sources");
    expect(() => readPreviewVerificationMode(valid, {
      environment: "production",
      secret,
      nowSeconds: Number(timestamp),
    })).toThrow(PreviewVerificationRejectedError);
    expect(() => readPreviewVerificationMode(valid, {
      environment: "preview",
      secret,
      nowSeconds: Number(timestamp) + 91,
    })).toThrow(PreviewVerificationRejectedError);
    expect(() => readPreviewVerificationMode({ ...valid, url: `${url}&stream=1` }, {
      environment: "preview",
      secret,
      nowSeconds: Number(timestamp),
    })).toThrow(PreviewVerificationRejectedError);
    expect(() => readPreviewVerificationMode(signedRequest("fail-all-sources", "x".repeat(32)), {
      environment: "preview",
      secret,
      nowSeconds: Number(timestamp),
    })).toThrow(PreviewVerificationRejectedError);
  });
});

describe("preview verification RPC client", () => {
  const result: RpcResult = { data: [{ id: "real" }], error: null };

  function baseClient() {
    const rpc = vi.fn(() => Promise.resolve(result));
    return { rpc, client: { rpc } as RpcCapableClient };
  }

  it("fails only transcripts for a controlled degraded result", async () => {
    const base = baseClient();
    const client = previewVerificationClient(base.client, "degrade-transcripts");

    await expect(client.rpc("search_transcripts_hybrid_batch_v3")).resolves.toEqual({
      data: null,
      error: { code: "ASP_VERIFY" },
    });
    await expect(client.rpc("search_verses_hybrid_batch_v3")).resolves.toEqual(result);
    expect(base.rpc).toHaveBeenCalledTimes(1);
  });

  it("preserves bound non-RPC methods used by authoritative refetches", () => {
    const rpc = vi.fn(() => Promise.resolve(result));
    const from = vi.fn(function (this: { marker: string }, table: string) {
      return { marker: this.marker, table };
    });
    const base = { marker: "base-client", rpc, from };

    const client = previewVerificationClient(base, "degrade-transcripts");

    expect(client.from("verses")).toEqual({ marker: "base-client", table: "verses" });
    expect(from).toHaveBeenCalledWith("verses");
  });

  it("fails all five retrieval RPCs but passes unrelated RPCs through", async () => {
    const base = baseClient();
    const client = previewVerificationClient(base.client, "fail-all-sources");
    const functions = [
      "search_transcripts_hybrid_batch_v3",
      "search_verses_hybrid_batch_v3",
      "search_prose_hybrid_batch_v3",
      "search_verse_chunks_hybrid_batch_v3",
      "search_letters_hybrid_batch_v3",
    ];

    for (const fn of functions) {
      await expect(client.rpc(fn)).resolves.toMatchObject({ error: { code: "ASP_VERIFY" } });
    }
    await expect(client.rpc("resolve_vocabulary_terms_v1")).resolves.toEqual(result);
    expect(base.rpc).toHaveBeenCalledOnce();
  });
});
