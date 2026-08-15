/**
 * qa-archive.ts — Every question, and the exact answer the browser received.
 *
 * `search_logs` is technical telemetry and stores only a hash of the question.
 * This is the other half: the raw question and the complete final response
 * object — main answer, every main passage, citations, speaker information,
 * Vedabase URLs, and the entire Dig Deeper list — exactly as it went out.
 *
 * Three rules shape every line here:
 *
 *   - THE SERVER STORES WHAT IT IS ABOUT TO RETURN. The archived JSON is the
 *     same object the response is serialized from, taken at the wire boundary
 *     after the payload guard. The browser is never asked to send the answer
 *     back, so nothing it could do can change what was recorded.
 *   - AN ANSWER IS NEVER INVENTED. A search that fails keeps its question and
 *     is marked `failed` with no response at all. The table's own CHECK
 *     constraint refuses any other shape.
 *   - THE ARCHIVE NEVER BREAKS OR SLOWS A SEARCH. Every write is wrapped, has
 *     an aborting deadline, and fails open with a log line. The completion
 *     write is handed to `after()` so it runs once the response has already
 *     gone out; a devotee never waits for the archive.
 *
 * Cache hits are archived too — a hit is a real serving, so it gets its own row
 * carrying the JSON that was actually served.
 */
import { after } from "next/server";
import { getSupabaseAdmin } from "@/app/lib/01-supabase";

const DEFAULT_WRITE_DEADLINE_MS = 2_000;

/**
 * `abandoned` is never written from here. A search cannot know that it died, so
 * the sweep in the migration (settle_stale_qa_archive_rows) is what settles a
 * `running` row whose outcome was never observed — keeping the question and
 * inventing no answer. It is listed because it is a status this table holds.
 */
export type QaArchiveStatus = "running" | "success" | "failed" | "abandoned";

export interface QaArchiveHandle {
  /** Primary key of the row opened when the question arrived. */
  rowId: string;
  requestId: string;
}

export interface QaArchiveBeginInput {
  requestId: string;
  searchLogId: string | null;
  /** The raw question, exactly as the devotee typed it. */
  question: string;
}

/** Injectable seam so the policy tests never need a database. */
export interface QaArchiveWriteAdapter {
  begin(input: QaArchiveBeginInput, signal: AbortSignal): Promise<string>;
  complete(
    handle: QaArchiveHandle,
    responseJson: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void>;
  fail(handle: QaArchiveHandle, signal: AbortSignal): Promise<void>;
}

export interface QaArchiveOptions {
  adapter?: QaArchiveWriteAdapter;
  deadlineMs?: number;
}

class QaArchiveDeadlineError extends Error {
  constructor() {
    super("qa_archive write deadline exceeded");
    this.name = "QaArchiveDeadlineError";
  }
}

/** A short, printable code — never a message that could carry a raw question. */
function safeErrorCode(err: unknown): string {
  if (err instanceof QaArchiveDeadlineError) return "deadline_exceeded";
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = String((err as { code?: unknown }).code ?? "");
    if (/^[A-Za-z0-9_-]{1,40}$/.test(code)) return code;
  }
  return "write_failed";
}

function logFailure(event: string, requestId: string, err: unknown): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      event,
      requestId,
      code: safeErrorCode(err),
    }),
  );
}

async function withDeadline<T>(
  deadlineMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

const supabaseAdapter: QaArchiveWriteAdapter = {
  async begin(input, signal) {
    const { data, error } = await getSupabaseAdmin()
      .from("qa_archive")
      .insert({
        request_id: input.requestId,
        search_log_id: input.searchLogId,
        question: input.question,
        status: "running",
      })
      .select("id")
      .abortSignal(signal)
      .single();
    if (error) throw error;
    const rowId = (data as { id?: unknown } | null)?.id;
    if (typeof rowId !== "string" || rowId.length === 0) {
      throw Object.assign(new Error("qa_archive insert returned no id"), {
        code: "invalid_response",
      });
    }
    return rowId;
  },

  async complete(handle, responseJson, signal) {
    const { error } = await getSupabaseAdmin()
      .from("qa_archive")
      .update({
        response_json: responseJson,
        status: "success",
        completed_at: new Date().toISOString(),
      })
      .eq("id", handle.rowId)
      .abortSignal(signal);
    if (error) throw error;
  },

  async fail(handle, signal) {
    const { error } = await getSupabaseAdmin()
      .from("qa_archive")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", handle.rowId)
      .abortSignal(signal);
    if (error) throw error;
  },
};

/**
 * Opens the row for an arriving question. Returns null when the write fails —
 * the caller carries that null through and simply archives nothing, because a
 * search must answer whether or not it can be recorded.
 */
export async function beginQaArchive(
  input: QaArchiveBeginInput,
  options: QaArchiveOptions = {},
): Promise<QaArchiveHandle | null> {
  const adapter = options.adapter ?? supabaseAdapter;
  const deadlineMs = options.deadlineMs ?? DEFAULT_WRITE_DEADLINE_MS;
  try {
    const rowId = await withDeadline(deadlineMs, (signal) => adapter.begin(input, signal));
    return { rowId, requestId: input.requestId };
  } catch (err) {
    logFailure("search.qa_archive_begin_failed", input.requestId, err);
    return null;
  }
}

/**
 * Finishes the row with the exact response the server is about to return.
 *
 * `responseJson` must be the guarded wire object, not the internal pipeline
 * output: what is archived has to be what the browser actually received.
 */
export async function completeQaArchive(
  handle: QaArchiveHandle | null,
  responseJson: Record<string, unknown>,
  options: QaArchiveOptions = {},
): Promise<void> {
  if (!handle) return;
  const adapter = options.adapter ?? supabaseAdapter;
  const deadlineMs = options.deadlineMs ?? DEFAULT_WRITE_DEADLINE_MS;
  try {
    await withDeadline(deadlineMs, (signal) => adapter.complete(handle, responseJson, signal));
  } catch (err) {
    logFailure("search.qa_archive_complete_failed", handle.requestId, err);
  }
}

/**
 * Marks the row failed, keeping the question and storing no answer. A search
 * that broke is recorded as a search that broke.
 */
export async function failQaArchive(
  handle: QaArchiveHandle | null,
  options: QaArchiveOptions = {},
): Promise<void> {
  if (!handle) return;
  const adapter = options.adapter ?? supabaseAdapter;
  const deadlineMs = options.deadlineMs ?? DEFAULT_WRITE_DEADLINE_MS;
  try {
    await withDeadline(deadlineMs, (signal) => adapter.fail(handle, signal));
  } catch (err) {
    logFailure("search.qa_archive_fail_failed", handle.requestId, err);
  }
}

/**
 * Runs the completion write after the response has gone out.
 *
 * `after()` is the Next.js hook for exactly this. Outside a request scope — a
 * unit test, a script — it throws, so the work is detached instead. Either way
 * the caller does not await it and nothing it does can reject into a search.
 */
export function scheduleQaArchiveWrite(work: () => Promise<void>): void {
  const guarded = async (): Promise<void> => {
    try {
      await work();
    } catch {
      // Every write inside `work` already fails open; this is the last net.
    }
  };
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}
