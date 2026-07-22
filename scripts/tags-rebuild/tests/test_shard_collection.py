"""
test_shard_collection.py — the interleave-collection-with-submission fix.

Before this fix the full run submitted every shard and only THEN collected, so a
run whose shards exceed the 3M enqueued-token queue deadlocked: jobs SUCCEEDED on
Google's side but were never downloaded, so their enqueued tokens were never
freed and the submit loop waited forever (0 retrieved, 0 applied).

The fix: the submit path's queue-full wait now runs a NON-BLOCKING collection
sweep (`collect_terminal_once`) that downloads + applies whatever has finished —
freeing enqueued-token quota AND advancing applied progress — keyed off the
recorded provider_job_ids so nothing is ever re-submitted or double-billed.

All DETERMINISTIC and OFFLINE (no DB, no Gemini): db + gemini_client are
monkeypatched at the tagging module boundary, matching the existing test style.
"""
from pathlib import Path

import gemini_client
import tagging

TAGGING_SRC = Path(tagging.__file__).read_text()
RUN_ALL_SRC = Path(Path(tagging.__file__).parent / "run_all.py").read_text()


# ── fakes ────────────────────────────────────────────────────────────────────
class _FakeCursor:
    def __init__(self, sink):
        self.sink = sink

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.sink.append((sql, params))


class _FakePG:
    def __init__(self, sink):
        self.sink = sink

    def cursor(self):
        return _FakeCursor(self.sink)


def _patch_db(monkeypatch, rows):
    """Wire tagging.db so a shard poll returns `rows`, with_retry runs its thunk,
    and every UPDATE is captured for assertions."""
    executes: list = []
    monkeypatch.setattr(tagging.db, "rows", lambda *a, **k: list(rows))
    monkeypatch.setattr(tagging.db, "with_retry", lambda fn, *a, **k: fn())
    monkeypatch.setattr(tagging.db, "get_pg", lambda: _FakePG(executes))
    monkeypatch.setattr(tagging, "usage_from_results_file", lambda p: (100, 50, 40, 10))
    return executes


# ── collect_terminal_once: the interleave sweep ──────────────────────────────
def test_collect_terminal_once_downloads_and_applies_a_succeeded_shard(monkeypatch):
    executes = _patch_db(monkeypatch, [("full:v4:r:0000", "verses", "prov/1", "submitted")])
    downloaded, applied = [], []
    monkeypatch.setattr(tagging.gemini_client, "get_batch",
                        lambda name: {"state": gemini_client.SUCCESS_STATE,
                                      "output_file": "out/1", "done": True})
    monkeypatch.setattr(tagging.gemini_client, "download_file",
                        lambda f, p: downloaded.append((f, p)))
    monkeypatch.setattr(tagging, "apply_results",
                        lambda sk, t, rp, rid, v: applied.append(sk) or "OUTCOME")

    freed = tagging.collect_terminal_once("run-1", "full:v4:r:", vocab="VOCAB", apply=True)

    assert freed == 1                       # its enqueued tokens were freed
    assert downloaded == [("out/1", tagging.config.SHARDS_DIR / "full_v4_r_0000.results.jsonl")]
    assert applied == ["full:v4:r:0000"]    # and it was applied (progress advanced)
    # the job left the in-flight queue: status flipped to 'retrieved' then applied
    flips = " ".join(sql for sql, _ in executes)
    assert "status='retrieved'" in flips


def test_collect_terminal_once_download_only_does_not_apply(monkeypatch):
    # pilot path (apply=False): a SUCCEEDED shard is downloaded to 'retrieved'
    # (freeing quota) but never applied here — the pilot applies atomically later.
    _patch_db(monkeypatch, [("pilot:v4:r:0000", "verses", "prov/1", "submitted")])
    applied = []
    monkeypatch.setattr(tagging.gemini_client, "get_batch",
                        lambda name: {"state": gemini_client.SUCCESS_STATE,
                                      "output_file": "out/1", "done": True})
    monkeypatch.setattr(tagging.gemini_client, "download_file", lambda f, p: None)
    monkeypatch.setattr(tagging, "apply_results",
                        lambda *a, **k: applied.append(1) or "OUTCOME")

    freed = tagging.collect_terminal_once("run-1", "pilot:v4:r:", vocab=None, apply=False)

    assert freed == 1 and applied == []     # freed quota, but nothing applied


def test_collect_terminal_once_is_non_blocking_when_nothing_finished(monkeypatch):
    # A still-running shard frees nothing and the sweep returns IMMEDIATELY — it
    # never sleeps/waits (that is collect()'s job, not the interleave sweep's).
    _patch_db(monkeypatch, [("full:v4:r:0000", "verses", "prov/1", "running")])
    monkeypatch.setattr(tagging.gemini_client, "get_batch",
                        lambda name: {"state": "BATCH_STATE_RUNNING", "done": False})

    def _no_wait(*a, **k):
        raise AssertionError("the interleave sweep must never block on a wait")

    monkeypatch.setattr(tagging, "_wait_with_progress", _no_wait)
    assert tagging.collect_terminal_once("run-1", "full:v4:r:", vocab="V", apply=True) == 0


def test_collect_terminal_once_one_shard_blip_does_not_abort_the_sweep(monkeypatch):
    # A poll/download error on one shard is swallowed so a single bad shard can't
    # abort submission; the other shard still gets collected.
    _patch_db(monkeypatch, [("full:v4:r:0000", "verses", "prov/bad", "submitted"),
                            ("full:v4:r:0001", "verses", "prov/ok", "submitted")])

    def flaky_get(name):
        if name == "prov/bad":
            raise RuntimeError("transient poll error")
        return {"state": gemini_client.SUCCESS_STATE, "output_file": "out", "done": True}

    monkeypatch.setattr(tagging.gemini_client, "get_batch", flaky_get)
    monkeypatch.setattr(tagging.gemini_client, "download_file", lambda f, p: None)
    monkeypatch.setattr(tagging, "apply_results", lambda *a, **k: "OUTCOME")
    # with_retry re-raises whatever the thunk raises (patched to call once)
    assert tagging.collect_terminal_once("run-1", "full:v4:r:", vocab="V", apply=True) == 1


# ── _poll_queue_quota: collection is what frees the slot ─────────────────────
def test_queue_wait_frees_a_slot_by_collecting(monkeypatch):
    monkeypatch.setattr(tagging, "_wait_with_progress", lambda *a, **k: None)
    monkeypatch.setattr(tagging, "_inflight_jobs_from_db", lambda: [])  # no terminal detection
    # collect_fn downloaded 2 finished shards → a slot is genuinely freed even
    # though no *newly-terminal* submitted job was observed.
    assert tagging._poll_queue_quota(set(), collect_fn=lambda: 2) is True
    # nothing finished and nothing terminal → no slot freed, keep waiting.
    assert tagging._poll_queue_quota(set(), collect_fn=lambda: 0) is False


def test_queue_wait_bakeoff_path_still_frees_via_terminal_state(monkeypatch):
    # The NO-DB bakeoff passes no collect_fn; a job reaching a terminal state
    # still frees a slot (it downloads on its own separate pass).
    monkeypatch.setattr(tagging, "_wait_with_progress", lambda *a, **k: None)
    monkeypatch.setattr(tagging.gemini_client, "get_batch",
                        lambda j: {"state": "BATCH_STATE_SUCCEEDED", "done": True})
    seen: set = set()
    assert tagging._poll_queue_quota(seen, inflight_fn=lambda: ["prov/9"]) is True
    assert "prov/9" in seen
    # already counted → not a NEW freeing on the next cycle
    assert tagging._poll_queue_quota(seen, inflight_fn=lambda: ["prov/9"]) is False


# ── progress line: "done" is scoped to the phase's shards (fix item 3) ────────
def test_run_progress_line_scopes_shard_counts_to_prefix(monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(tagging.db, "one", lambda *a, **k: 5)  # applied passages

    def fake_rows(sql, params):
        captured["sql"] = sql
        captured["params"] = params
        return [(2, 1, 3, 4.0)]  # shards_done, in_flight, shards_total, real_usd

    monkeypatch.setattr(tagging.db, "rows", fake_rows)
    monkeypatch.setattr(tagging, "_eligible_total", lambda: 100)

    line = tagging.run_progress_line("run-1", "full:v4:abc:")
    assert "shard_key LIKE %(like)s" in captured["sql"]
    assert captured["params"]["like"] == "full:v4:abc:%"
    assert "shards 2/3 done, 1 in flight" in line
    # default (no prefix) counts every shard for the run — no LIKE filter
    tagging.run_progress_line("run-1")
    assert "shard_key LIKE" not in captured["sql"]


# ── source tripwires: the interleave is actually wired end-to-end ─────────────
def test_collection_never_resubmits_or_double_bills():
    # the sweep acts ONLY on recorded provider_job_ids: it must never create or
    # upload a batch job (that would resubmit / double-bill already-submitted work)
    src = TAGGING_SRC[TAGGING_SRC.index("def collect_terminal_once"):]
    src = src[:src.index("\ndef ", 1)] if "\ndef " in src[1:] else src
    assert "create_batch" not in src
    assert "upload_jsonl" not in src
    assert "provider_job_id" in src  # it selects the recorded job ids


def test_queue_wait_runs_the_collection_sweep():
    src = TAGGING_SRC[TAGGING_SRC.index("def _poll_queue_quota"):]
    src = src[:src.index("\ndef _create_batch_draining_queue")]
    assert "collect_fn() if collect_fn is not None else 0" in src
    assert "freed = collected > 0" in src


def test_run_full_interleaves_collection_with_submission():
    # run_full threads a full-run collect sweep into submit_pending AND scopes the
    # progress line to the full prefix, so submission and collection interleave.
    src = RUN_ALL_SRC[RUN_ALL_SRC.index("def run_full"):]
    assert "collect_terminal_once(run_id, prefix, vocab_index, apply=True)" in src
    assert "collect_fn=collect_finished_full_shards" in src
    assert "shard_prefix=prefix" in src


def test_pilot_interleaves_download_only_collection():
    # the v4 pilot interleaves a DOWNLOAD-ONLY sweep (apply=False, vocab None) —
    # it frees quota without applying (the pilot applies atomically later).
    assert "collect_terminal_once(run_id, prefix, None, apply=False)" in RUN_ALL_SRC
    assert RUN_ALL_SRC.count("collect_fn=collect_finished_pilot_shards") >= 3
