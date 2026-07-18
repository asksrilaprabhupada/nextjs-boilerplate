"""
gemini_client.py — raw-HTTP client for the Gemini API (models, Files, Batch).

Raw `requests` against v1beta, matching the app's fetch approach
(app/lib/16-multi-query.ts). No SDK. All paid traffic in this harness goes
through the **Batch API** (50% pricing, server-side up to 24h):

  confirm_model()        free models.list read — resolves the exact CURRENT
                         full-Flash model string for config.GEMINI_MODEL and
                         asserts it supports batchGenerateContent. Refuses
                         -lite variants. Used by --doctor and before any run.
  upload_jsonl(path,dn)  File API resumable upload → "files/…" name
  create_batch(...)      models/{model}:batchGenerateContent with a file
                         input_config → "batches/…" job name
  get_batch(name)        poll one job (state, output file, usage)
  list_batches()         ALL jobs — restart reconciliation: accepted-but-
                         unrecorded jobs are recovered by display_name,
                         never resubmitted
  download_file(name)    stream a results file to disk

Request JSONL line:  {"key": "<table>:<uuid>", "request": {GenerateContentRequest}}
Response JSONL line: {"key": ..., "response": {GenerateContentResponse}} | {"key": ..., "error": {...}}
"""
from __future__ import annotations

import json
import random
import time
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

import requests

import config

TIMEOUT = 120
TERMINAL_STATES = {"BATCH_STATE_SUCCEEDED", "BATCH_STATE_FAILED", "BATCH_STATE_CANCELLED", "BATCH_STATE_EXPIRED"}
SUCCESS_STATE = "BATCH_STATE_SUCCEEDED"

# Transient Gemini statuses. A 503 "high demand" spike lasts MINUTES, so the
# interactive-call waits are patient (base ~15s → 240s, jittered) — far longer
# than db.with_retry's pooler-blip backoff. 400/401/403 and every other status
# are never retried: the request itself is wrong and must fail loudly.
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
RETRY_WAITS = (15, 30, 60, 120, 240)  # 6 attempts total: the first + these 5


class GeminiError(RuntimeError):
    pass


class GeminiHTTPError(GeminiError):
    """HTTP-level Gemini failure carrying status + Retry-After for retry logic."""

    def __init__(self, what: str, res: requests.Response) -> None:
        super().__init__(f"Gemini {what} HTTP {res.status_code}: {res.text[:2000]}")
        self.status = res.status_code
        self.retry_after = _retry_after_seconds(res)


def _retry_after_seconds(res: requests.Response) -> Optional[float]:
    """Parse a Retry-After header (delta-seconds or HTTP-date) if present."""
    value = (res.headers.get("Retry-After") or "").strip()
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime

        return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
    except Exception:
        return None


def with_gemini_retry(fn: Callable[[], Any], what: str) -> Any:
    """Patient retry for interactive Gemini calls. Transient failures (HTTP
    429/500/502/503/504 as GeminiHTTPError, plus network-level errors) retry up
    to len(RETRY_WAITS) times with exponential backoff + jitter, honouring a
    server Retry-After when it asks for longer. Non-retryable HTTP errors
    (400/401/403/…) re-raise immediately — never swallowed, never retried."""
    for attempt, base_wait in enumerate((*RETRY_WAITS, None)):
        try:
            return fn()
        except GeminiHTTPError as exc:
            if exc.status not in RETRYABLE_STATUS or base_wait is None:
                raise
            wait = base_wait * (1 + random.random() * 0.25)
            if exc.retry_after is not None:
                wait = max(wait, exc.retry_after)
            print(
                f"  Gemini {what}: transient HTTP {exc.status} — waiting {wait:.0f}s,"
                f" then retry {attempt + 1}/{len(RETRY_WAITS)}",
                flush=True,
            )
            time.sleep(wait)
        except requests.RequestException as exc:
            if base_wait is None:
                raise
            wait = base_wait * (1 + random.random() * 0.25)
            print(
                f"  Gemini {what}: network error ({exc}) — waiting {wait:.0f}s,"
                f" then retry {attempt + 1}/{len(RETRY_WAITS)}",
                flush=True,
            )
            time.sleep(wait)


def _key() -> str:
    if not config.GEMINI_API_KEY:
        raise SystemExit("FATAL: GEMINI_API_KEY missing — see `python run_all.py --doctor`.")
    return config.GEMINI_API_KEY


def _check(res: requests.Response, what: str) -> dict:
    if not res.ok:
        raise GeminiHTTPError(what, res)
    return res.json()


def _get(url: str, what: str, params: Optional[dict] = None) -> dict:
    params = dict(params or {})
    params["key"] = _key()
    return _check(requests.get(url, params=params, timeout=TIMEOUT), what)


def _post(url: str, body: dict, what: str) -> dict:
    return _check(
        requests.post(url, params={"key": _key()}, json=body, timeout=TIMEOUT), what
    )


# ── Model confirmation (free, read-only) ────────────────────────────────────

def list_models() -> list[dict]:
    models: list[dict] = []
    page_token = None
    while True:
        params = {"pageSize": 200}
        if page_token:
            params["pageToken"] = page_token
        data = _get(f"{config.GEMINI_BASE}/models", "models.list", params)
        models.extend(data.get("models", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            return models


def confirm_model() -> str:
    """Resolve config.GEMINI_MODEL against the LIVE models list and return the
    exact current model string (without the 'models/' prefix). Loud rules:
      • must exist and support batchGenerateContent (falls back to
        generateContent support if the API doesn't list batch methods);
      • must be full Flash — any '-lite' match is refused, never substituted.
    If the configured string isn't listed verbatim, the newest non-lite
    versioned sibling (e.g. gemini-3.5-flash-002) is reported and REFUSED —
    a human pins it in .env; the harness never silently swaps models."""
    wanted = config.GEMINI_MODEL.removeprefix("models/")
    if "lite" in wanted.lower():
        raise SystemExit(
            f"FATAL: GEMINI_MODEL={wanted!r} is a Lite variant. The brief requires FULL"
            " Gemini 3.5 Flash — fix GEMINI_MODEL in .env."
        )
    models = list_models()
    by_name = {m.get("name", "").removeprefix("models/"): m for m in models}
    entry = by_name.get(wanted)
    if entry is None:
        siblings = sorted(
            name
            for name in by_name
            if name.startswith(wanted) and "lite" not in name.lower()
        )
        hint = (
            f" The API currently lists these non-lite siblings: {', '.join(siblings)}."
            if siblings
            else " The API lists no sibling of that family."
        )
        raise SystemExit(
            f"FATAL: model {wanted!r} is not in the live models list.{hint}"
            " Pin the exact current string in .env (GEMINI_MODEL=...) — the harness"
            " never swaps models silently."
        )
    methods = entry.get("supportedGenerationMethods") or entry.get("supportedActions") or []
    if methods and not any(m in methods for m in ("batchGenerateContent", "generateContent")):
        raise SystemExit(
            f"FATAL: model {wanted!r} does not support generateContent/batchGenerateContent"
            f" (supports: {methods})."
        )
    return wanted


# ── File API ────────────────────────────────────────────────────────────────

def upload_jsonl(path: Path, display_name: str) -> str:
    """Resumable upload of a request-JSONL shard. Returns the 'files/…' name."""
    size = path.stat().st_size
    start = requests.post(
        f"{config.GEMINI_UPLOAD_BASE}/files",
        params={"key": _key()},
        headers={
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(size),
            "X-Goog-Upload-Header-Content-Type": "application/jsonl",
            "Content-Type": "application/json",
        },
        json={"file": {"display_name": display_name}},
        timeout=TIMEOUT,
    )
    if not start.ok:
        raise GeminiError(f"Gemini file upload start HTTP {start.status_code}: {start.text[:2000]}")
    upload_url = start.headers.get("X-Goog-Upload-URL") or start.headers.get("x-goog-upload-url")
    if not upload_url:
        raise GeminiError("Gemini file upload start returned no X-Goog-Upload-URL header")
    with open(path, "rb") as f:
        finish = requests.post(
            upload_url,
            headers={
                "X-Goog-Upload-Command": "upload, finalize",
                "X-Goog-Upload-Offset": "0",
                "Content-Length": str(size),
            },
            data=f,
            timeout=max(TIMEOUT, 600),
        )
    data = _check(finish, "file upload finalize")
    name = (data.get("file") or {}).get("name")
    if not name:
        raise GeminiError(f"Gemini file upload returned no file name: {json.dumps(data)[:500]}")
    return name


def download_file(file_name: str, dest: Path) -> Path:
    """Stream 'files/…' (a batch results file) to dest."""
    url = f"{config.GEMINI_DOWNLOAD_BASE}/{file_name}:download"
    with requests.get(url, params={"key": _key(), "alt": "media"}, stream=True, timeout=600) as res:
        if not res.ok:
            raise GeminiError(f"Gemini file download HTTP {res.status_code}: {res.text[:2000]}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as f:
            for chunk in res.iter_content(chunk_size=1 << 20):
                f.write(chunk)
    return dest


# ── Batch API ───────────────────────────────────────────────────────────────

def create_batch(model: str, input_file_name: str, display_name: str) -> str:
    """Create a batch job over an uploaded request file. Returns the job name
    ('batches/…'). REST body per the Gemini Batch docs: for a file-based batch
    the uploaded file goes DIRECTLY under batch.input_config.file_name (the
    'requests' wrapper is only for inline requests, which we don't use)."""
    data = _post(
        f"{config.GEMINI_BASE}/models/{model}:batchGenerateContent",
        {
            "batch": {
                "display_name": display_name,
                "input_config": {"file_name": input_file_name},
            }
        },
        "batch create",
    )
    name = data.get("name")
    if not name:
        raise GeminiError(f"Gemini batch create returned no name: {json.dumps(data)[:500]}")
    return name


def get_batch(batch_name: str) -> dict:
    """Poll one batch job. Returns a normalized view:
    {name, display_name, state, done, output_file, error, usage}."""
    data = _get(f"{config.GEMINI_BASE}/{batch_name}", "batch get")
    return _normalize_batch(data)


def _normalize_batch(data: dict) -> dict:
    meta = data.get("metadata") or {}
    # The long-running-operation wrapper puts batch fields in metadata; some
    # responses inline them. Read both defensively.
    src = {**data, **meta}
    response = data.get("response") or src.get("response") or {}
    # The succeeded output file surfaces under different keys across API
    # revisions: response.responsesFile, response.output.responsesFile,
    # metadata.output.responsesFile, or dest.fileName (SDK-style). Try all.
    output = src.get("output") or response.get("output") or {}
    output_file = (
        response.get("responsesFile")
        or output.get("responsesFile")
        or (response.get("dest") or {}).get("fileName")
        or (src.get("dest") or {}).get("fileName")
    )
    return {
        "name": src.get("name") or data.get("name"),
        "display_name": src.get("displayName") or src.get("display_name") or "",
        "state": src.get("state") or "",
        "done": bool(data.get("done")) or (src.get("state") in TERMINAL_STATES),
        "output_file": output_file,
        "error": data.get("error") or src.get("error"),
        "usage": src.get("batchStats") or src.get("usageMetadata") or {},
        "raw": data,
    }


def list_batches() -> Iterator[dict]:
    """Iterate ALL batch jobs for this key (normalized) — reconciliation uses
    display_name to recover accepted-but-unrecorded jobs after a crash."""
    page_token = None
    while True:
        params = {"pageSize": 100}
        if page_token:
            params["pageToken"] = page_token
        data = _get(f"{config.GEMINI_BASE}/batches", "batch list", params)
        for item in data.get("operations") or data.get("batches") or []:
            yield _normalize_batch(item)
        page_token = data.get("nextPageToken")
        if not page_token:
            return


def wait_terminal(batch_name: str, poll_seconds: int) -> dict:
    """Block until the job reaches a terminal state (jobs run up to 24h server-
    side — callers may instead Ctrl+C and rerun later; state is in the DB)."""
    while True:
        job = get_batch(batch_name)
        if job["state"] in TERMINAL_STATES or job["done"]:
            return job
        time.sleep(poll_seconds)
