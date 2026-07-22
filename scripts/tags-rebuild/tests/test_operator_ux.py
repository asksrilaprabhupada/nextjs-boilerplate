"""
test_operator_ux.py — the three operator-experience fixes for the full run.

All DETERMINISTIC and OFFLINE (no DB, no Gemini, no credentials), matching the
existing test style: pure logic exercised directly; DB-facing SQL and print
behaviour asserted via source-text tripwires.

1. SHARD SIZE — the shard input-token cap is config.SHARD_MAX_INPUT_TOKENS
   (default 400K, so ~6 jobs share the 3M enqueued-token queue concurrently
   instead of one 2.5M job blocking it), and wave planning discards still-
   'pending' shards so they re-plan at the current size (submitted/retrieved/
   applied shards are never touched).
2. QUIET 429s — a queue-full HTTP 429 on batch create is expected behaviour:
   one short line per wait cycle, never the JSON error body; non-429 errors
   keep their full bodies.
3. LIVE PROGRESS — a cheap DB-only progress line every 30s while waiting on
   batch jobs; Google's job states keep their existing poll interval.
"""
from pathlib import Path

import pytest

import bakeoff
import config
import db
import tagging

TAGGING_SRC = Path(tagging.__file__).read_text()
BAKEOFF_SRC = Path(bakeoff.__file__).read_text()


# ── fix 1: SHARD_MAX_INPUT_TOKENS (400K default) + pending-shard re-plan ─────

def test_shard_cap_is_a_config_with_400k_default():
    assert config.SHARD_MAX_INPUT_TOKENS == 400_000
    # the old 2.5M constant is gone everywhere (config, pipeline and bakeoff)
    assert not hasattr(config, "MAX_SHARD_INPUT_TOKENS")
    assert "MAX_SHARD_INPUT_TOKENS" not in TAGGING_SRC.replace("SHARD_MAX_INPUT_TOKENS", "")
    assert "MAX_SHARD_INPUT_TOKENS" not in BAKEOFF_SRC.replace("SHARD_MAX_INPUT_TOKENS", "")


def test_pack_parts_respects_the_configured_cap(monkeypatch):
    monkeypatch.setattr(config, "SHARD_MAX_INPUT_TOKENS", 100)
    lines = [(f"id{i}", "x", 40) for i in range(6)]
    parts = tagging._pack_parts(lines)
    assert [sum(tok for _, _, tok in part) for part in parts] == [80, 80, 80]
    # a single line larger than the cap gets its own part, never dropped
    solo = tagging._pack_parts([("big", "x", 500)])
    assert len(solo) == 1 and solo[0][0][0] == "big"


def test_wave_planning_discards_only_never_accepted_pending_shards():
    # plan_full_shards deletes this run's still-'pending' rows (and ONLY rows
    # with no accepted provider job) before planning, so a wave re-plans them at
    # the current SHARD_MAX_INPUT_TOKENS; submitted/running/retrieved/applied/
    # failed shards are never re-planned here.
    src = TAGGING_SRC[TAGGING_SRC.index("def plan_full_shards"):]
    src = src[:src.index("\ndef _insert_shard")]
    assert "DELETE FROM public.tag_batch_jobs WHERE run_id = %s::uuid" in src
    assert "AND shard_key LIKE %s AND status = 'pending'" in src
    assert "AND provider_job_id IS NULL" in src
    # the discard is scoped to the run's full-shard prefix, never pilot keys
    assert "prefix = full_prefix(run_id)" in src


# ── fix 2: queue-full 429s are quiet ─────────────────────────────────────────

class _QueueFull(Exception):
    status = 429


def test_with_retry_can_raise_429_immediately_and_silently(capsys):
    calls = []

    def boom():
        calls.append(1)
        raise _QueueFull("queue full")

    with pytest.raises(_QueueFull):
        db.with_retry(boom, "batch create test", retry_429=False)
    assert len(calls) == 1              # no wasted backoff attempts
    assert capsys.readouterr().out == ""  # and no error body printed


def test_with_retry_still_retries_429_by_default(monkeypatch):
    # polling paths keep the old behaviour: 429 is transient there
    monkeypatch.setattr(db.time, "sleep", lambda s: None)
    calls = []

    def boom():
        calls.append(1)
        raise _QueueFull("rate limited")

    with pytest.raises(_QueueFull):
        db.with_retry(boom, "poll", attempts=3)
    assert len(calls) == 3


def test_batch_create_is_quiet_about_queue_full():
    # the create path opts out of 429 retries so the JSON body never prints…
    assert "retry_429=False" in TAGGING_SRC
    # …and the wait cycle prints exactly one short line, not a status wall
    assert 'print("  queue full — waiting for space", flush=True)' in TAGGING_SRC
    assert "batch queue full —" not in TAGGING_SRC


# ── fix 3: 30s live progress line ────────────────────────────────────────────

def test_progress_line_format_matches_the_spec():
    line = tagging.format_progress_line(12480, 244148, 8, 53, 2, 4.20)
    assert line == "12,480/244,148 passages (5.1%) · shards 8/53 done, 2 in flight · $4.20"
    # zero-division safe before anything is planned
    assert tagging.format_progress_line(0, 0, 0, 0, 0, 0.0) == (
        "0/0 passages (0.0%) · shards 0/0 done, 0 in flight · $0.00"
    )


def test_wait_ticks_every_30s_without_changing_the_poll_interval(monkeypatch, capsys):
    assert tagging.PROGRESS_LINE_SECONDS == 30
    sleeps = []
    monkeypatch.setattr(tagging.time, "sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(tagging, "run_progress_line", lambda run_id: "PROGRESS")
    tagging._wait_with_progress(300, "run-1")  # one 5-min queue-wait cycle
    assert sum(sleeps) == 300 and set(sleeps) == {30}   # full interval, 30s ticks
    assert capsys.readouterr().out.count("PROGRESS") == 10
    # no run context (the NO-DB bakeoff) → one plain sleep, no progress reads
    sleeps.clear()
    tagging._wait_with_progress(300, None)
    assert sleeps == [300]
    assert capsys.readouterr().out == ""


def test_progress_read_failures_never_abort_a_wait(monkeypatch, capsys):
    monkeypatch.setattr(tagging.time, "sleep", lambda s: None)

    def blow_up(run_id):
        raise RuntimeError("db blip")

    monkeypatch.setattr(tagging, "run_progress_line", blow_up)
    tagging._wait_with_progress(60, "run-1")  # must not raise
    assert "db blip" not in capsys.readouterr().out


def test_progress_line_reads_cheap_run_scoped_counts():
    src = TAGGING_SRC[TAGGING_SRC.index("def run_progress_line"):]
    src = src[:src.index("\ndef _wait_with_progress")]
    # applied Tier-3 passages for THIS run…
    assert "WHERE run_id = %s::uuid AND outcome = 'applied'" in src
    # …shards done / in flight / total in one query…
    assert "count(*) FILTER (WHERE status = 'applied')" in src
    assert "count(*) FILTER (WHERE status IN ('submitted','running','retrieved'))" in src
    # …and REAL spend only (retrieved/applied/failed at recorded prices)
    assert "'retrieved','applied','failed'" in src
    assert "est_input_tok" not in src


def test_both_wait_paths_use_the_progress_sleep():
    # collect's poll sleep and the queue-full drain both tick; the raw sleeps on
    # those intervals are gone, and the Google poll cadence constants are intact.
    assert "_wait_with_progress(config.BATCH_POLL_SECONDS, run_id)" in TAGGING_SRC
    assert "_wait_with_progress(QUEUE_QUOTA_POLL_SECONDS, run_id)" in TAGGING_SRC
    assert "time.sleep(config.BATCH_POLL_SECONDS)" not in TAGGING_SRC
    assert "time.sleep(QUEUE_QUOTA_POLL_SECONDS)" not in TAGGING_SRC
    assert tagging.QUEUE_QUOTA_POLL_SECONDS == 300
