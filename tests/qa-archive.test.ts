/**
 * qa_archive contracts — every question and the exact answer shown.
 *
 * The archive exists to be a permanent record, so the tests that matter are
 * about what it refuses to do: invent an answer for a failed search, trust the
 * browser, let a write failure reach a devotee, or slow a search down. The
 * table's own CHECK constraint is asserted separately in
 * qa-archive-migration.test.ts; here the writer's behaviour is pinned.
 */
import { describe, expect, it, vi } from "vitest";
import {
  beginQaArchive,
  completeQaArchive,
  failQaArchive,
  scheduleQaArchiveWrite,
  type QaArchiveHandle,
  type QaArchiveWriteAdapter,
} from "@/app/lib/search-v2/qa-archive";

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

interface RecordedRow {
  requestId: string;
  searchLogId: string | null;
  question: string;
  status: "running" | "success" | "failed";
  responseJson: Record<string, unknown> | null;
  completedAt: string | null;
}

/** In-memory stand-in for the table, so no test needs a database. */
function recordingAdapter(opts: {
  failBegin?: boolean;
  failComplete?: boolean;
  failFail?: boolean;
  hangMs?: number;
} = {}) {
  const rows = new Map<string, RecordedRow>();
  let nextId = 1;
  const adapter: QaArchiveWriteAdapter = {
    async begin(input, signal) {
      if (opts.hangMs) await hang(opts.hangMs, signal);
      if (opts.failBegin) throw Object.assign(new Error("insert failed"), { code: "PGRST301" });
      const id = `row-${nextId++}`;
      rows.set(id, {
        requestId: input.requestId,
        searchLogId: input.searchLogId,
        question: input.question,
        status: "running",
        responseJson: null,
        completedAt: null,
      });
      return id;
    },
    async complete(handle, responseJson) {
      if (opts.failComplete) throw Object.assign(new Error("update failed"), { code: "57014" });
      const row = rows.get(handle.rowId);
      if (!row) throw new Error("no such row");
      row.status = "success";
      row.responseJson = responseJson;
      row.completedAt = "2026-08-15T12:00:00.000Z";
    },
    async fail(handle) {
      if (opts.failFail) throw new Error("update failed");
      const row = rows.get(handle.rowId);
      if (!row) throw new Error("no such row");
      row.status = "failed";
      row.completedAt = "2026-08-15T12:00:00.000Z";
    },
  };
  return { adapter, rows };
}

function hang(ms: number, signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("should have aborted")), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });
}

const question = "How does one control the mind?";

describe("a question is archived the moment it arrives", () => {
  it("opens a running row carrying the raw question", async () => {
    const { adapter, rows } = recordingAdapter();
    const handle = await beginQaArchive(
      { requestId: REQUEST_ID, searchLogId: "log-1", question },
      { adapter },
    );
    expect(handle).not.toBeNull();
    expect([...rows.values()]).toEqual([{
      requestId: REQUEST_ID,
      searchLogId: "log-1",
      // The raw question, not a hash. search_logs stays hash-only; this table
      // is the one that keeps what was actually asked.
      question,
      status: "running",
      responseJson: null,
      completedAt: null,
    }]);
  });

  it("still opens a row when telemetry produced no search_log_id", async () => {
    const { adapter, rows } = recordingAdapter();
    await beginQaArchive({ requestId: REQUEST_ID, searchLogId: null, question }, { adapter });
    expect([...rows.values()][0].searchLogId).toBeNull();
  });
});

describe("the completion write stores exactly what the browser received", () => {
  it("stores the served response object and marks the row success", async () => {
    const { adapter, rows } = recordingAdapter();
    const handle = await beginQaArchive(
      { requestId: REQUEST_ID, searchLogId: "log-1", question },
      { adapter },
    );
    const served = {
      query: question,
      passages: [{ reference: "BG 6.35", text: "exact words", url: "https://vedabase.io/x/" }],
      additional: [{ reference: "Lecture", snippet: "exact words", url: "https://vedabase.io/y/" }],
      additionalCount: 1,
      totalResults: 2,
    };
    await completeQaArchive(handle, served, { adapter });
    const row = [...rows.values()][0];
    expect(row.status).toBe("success");
    expect(row.responseJson).toEqual(served);
    expect(row.completedAt).not.toBeNull();
  });

  it("reproduces the Dig Deeper list and its URLs verbatim", async () => {
    const { adapter, rows } = recordingAdapter();
    const handle = await beginQaArchive(
      { requestId: REQUEST_ID, searchLogId: null, question }, { adapter },
    );
    const additional = Array.from({ length: 40 }, (_, i) => ({
      reference: `Lecture ${i}`,
      snippet: `passage ${i}`,
      url: i % 2 === 0 ? `https://vedabase.io/en/library/transcripts/${i}/` : null,
    }));
    await completeQaArchive(handle, { additional, additionalCount: 40 }, { adapter });
    const stored = [...rows.values()][0].responseJson as { additional: unknown[] };
    expect(stored.additional).toEqual(additional);
    expect(stored.additional).toHaveLength(40);
  });
});

describe("a failed search keeps its question and invents no answer", () => {
  it("marks the row failed with no response stored", async () => {
    const { adapter, rows } = recordingAdapter();
    const handle = await beginQaArchive(
      { requestId: REQUEST_ID, searchLogId: "log-1", question },
      { adapter },
    );
    await failQaArchive(handle, { adapter });
    const row = [...rows.values()][0];
    expect(row.status).toBe("failed");
    expect(row.question).toBe(question);
    expect(row.responseJson).toBeNull();
  });
});

describe("the archive never breaks or slows a search", () => {
  it("returns null instead of throwing when the opening insert fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { adapter } = recordingAdapter({ failBegin: true });
    const handle = await beginQaArchive(
      { requestId: REQUEST_ID, searchLogId: null, question }, { adapter },
    );
    expect(handle).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("search.qa_archive_begin_failed"));
    // The code is printable and short — never a message that could leak the
    // raw question into a log aggregator.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PGRST301"));
    warn.mockRestore();
  });

  it("swallows a failed completion write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { adapter } = recordingAdapter({ failComplete: true });
    const handle = await beginQaArchive(
      { requestId: REQUEST_ID, searchLogId: null, question }, { adapter },
    );
    await expect(completeQaArchive(handle, { ok: true }, { adapter })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("search.qa_archive_complete_failed"));
    warn.mockRestore();
  });

  it("swallows a failed failure write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { adapter } = recordingAdapter({ failFail: true });
    const handle = await beginQaArchive(
      { requestId: REQUEST_ID, searchLogId: null, question }, { adapter },
    );
    await expect(failQaArchive(handle, { adapter })).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("does nothing at all when no row was ever opened", async () => {
    const { adapter, rows } = recordingAdapter();
    await completeQaArchive(null, { ok: true }, { adapter });
    await failQaArchive(null, { adapter });
    expect(rows.size).toBe(0);
  });

  it("abandons a write that exceeds its deadline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { adapter } = recordingAdapter({ hangMs: 10_000 });
    const handle = await beginQaArchive(
      { requestId: REQUEST_ID, searchLogId: null, question },
      { adapter, deadlineMs: 20 },
    );
    expect(handle).toBeNull();
    warn.mockRestore();
  });

  it("never lets a scheduled write reject into the request", async () => {
    let ran = false;
    expect(() => scheduleQaArchiveWrite(async () => {
      ran = true;
      throw new Error("archive exploded");
    })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toBe(true);
  });
});

describe("the handle identifies one row per request", () => {
  it("carries the request id for correlation", async () => {
    const { adapter } = recordingAdapter();
    const handle = await beginQaArchive(
      { requestId: REQUEST_ID, searchLogId: null, question }, { adapter },
    ) as QaArchiveHandle;
    expect(handle.requestId).toBe(REQUEST_ID);
    expect(handle.rowId).toBe("row-1");
  });
});
