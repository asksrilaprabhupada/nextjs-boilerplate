"""Approval-gated transcript speaker dry-run and backfill runner.

The default workflow is deliberately split in two:

* ``dry-run`` reads the public Supabase Data API with a publishable key, maps
  the complete corpus locally, and freezes evidence artifacts. It has no
  database write path.
* ``apply`` accepts only the exact frozen artifact approved by its SHA-256
  marker. It uses a direct/session PostgreSQL connection, verifies every row
  in transcript-complete batches, and updates only ``speaker_names``.

No schema migration is applied by this script. The additive column migration
is a separate owner-approval gate.
"""

from __future__ import annotations

import argparse
from collections import Counter
from contextlib import suppress
from datetime import datetime, timezone
from hashlib import sha256
from importlib.metadata import PackageNotFoundError, version as package_version
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Iterable, Iterator, Mapping, Sequence
from urllib.parse import urlparse
from uuid import UUID

import requests

from mapper import (
    CANONICAL_PRABHUPADA,
    UNKNOWN_SPEAKER,
    audited_exact_speaker_proofs,
    canonical_json,
    map_corpus,
)


FORMAT_VERSION = 1
TABLE_NAME = "transcript_paragraphs"
DEFAULT_PAGE_SIZE = 1_000
MAX_PAGE_SIZE = 1_000
DEFAULT_BATCH_SIZE = 500
MAX_BATCH_SIZE = 500
EXPECTED_VECTOR_FUNCTION_EXACT_MD5 = "2b79af99b4080b9c2c0b80ef8a642074"
EXPECTED_VECTOR_FUNCTION_CONFIG = ["search_path=public, pg_temp"]
APPROVAL_ENV = "TRANSCRIPT_SPEAKER_BACKFILL_APPROVAL"
APPROVAL_PREFIX = "I_APPROVE_TRANSCRIPT_SPEAKER_BACKFILL:"
DEFAULT_ARTIFACT_DIR = Path("work/transcript-speaker-backfill")
EXPECTED_REQUESTS_VERSION = "2.34.2"
EXPECTED_PSYCOPG_VERSION = "3.3.4"

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = Path(__file__).resolve()
MAPPER_PATH = SCRIPT_PATH.with_name("mapper.py")
RECOMPUTE_PATH = SCRIPT_PATH.with_name("recompute.py")
REQUIREMENTS_PATH = SCRIPT_PATH.with_name("requirements.txt")
MIGRATION_PATH = (
    REPO_ROOT
    / "supabase"
    / "migrations"
    / "20260809143133_add_transcript_speaker_names.sql"
)
ROLLBACK_PATH = (
    REPO_ROOT
    / "supabase"
    / "rollbacks"
    / "20260809143133_leave_transcript_speaker_names_inert.sql"
)

MAPPING_FILE = "proposed-mapping.ndjson"
SUSPICIOUS_FILE = "suspicious.ndjson"
VERIFICATION_FILE = "verification.json"
MANIFEST_FILE = "run-manifest.json"
MANIFEST_SHA_FILE = "run-manifest.sha256"
LEDGER_FILE = "apply-ledger.jsonl"

_REQUIRED_SOURCE_FIELDS = {
    "id",
    "transcript_id",
    "paragraph_number",
    "body_text",
}
_MAPPING_FIELDS = {
    "id",
    "transcriptId",
    "paragraphNumber",
    "bodySha256",
    "speakerNames",
    "beforeSpeaker",
    "afterSpeaker",
    "evidenceModes",
    "suspiciousCodes",
}
_EVIDENCE_MODE_ORDER = (
    "explicit",
    "inherited",
    "mixed",
    "unknown",
    "suspicious",
)
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_CONTENT_RANGE_PATTERN = re.compile(r"^(?:\d+-\d+|\*)/(\d+)$")

_REFERENCE_FIXTURES = (
    {
        "name": "1975 Vṛndāvana screenshot paragraph",
        "id": "7a59854c-12f8-47ff-a770-c576aff45fe1",
        "expectedSpeakerNames": [CANONICAL_PRABHUPADA],
    },
    {
        "name": "1976 Vṛndāvana screenshot paragraph",
        "id": "c8de2aaf-6926-4bf9-b778-51ad1f6293d5",
        "expectedSpeakerNames": [CANONICAL_PRABHUPADA, "Devotees"],
    },
)


class BackfillError(RuntimeError):
    """A fail-closed operator error that is safe to print without a traceback."""


def _verify_runtime_dependencies(*, require_psycopg: bool) -> None:
    expected = {"requests": EXPECTED_REQUESTS_VERSION}
    if require_psycopg:
        expected["psycopg"] = EXPECTED_PSYCOPG_VERSION
    for package, expected_version in expected.items():
        try:
            observed = package_version(package)
        except PackageNotFoundError as exc:
            raise BackfillError(f"required pinned dependency is missing: {package}") from exc
        if observed != expected_version:
            raise BackfillError(
                f"{package} version drifted; expected {expected_version}, observed {observed}"
            )


def _sha256_bytes(value: bytes) -> str:
    return sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _relative_repo_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError as exc:
        raise BackfillError(f"required code file is outside the repository: {path}") from exc


def _require_file(path: Path, purpose: str) -> None:
    if not path.is_file():
        raise BackfillError(f"missing {purpose}: {_relative_repo_path(path)}")


def _canonical_uuid(value: object, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise BackfillError(f"{field} must be a non-empty canonical UUID string")
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as exc:
        raise BackfillError(f"{field} is not a UUID: {value!r}") from exc
    canonical = str(parsed)
    if value != canonical:
        raise BackfillError(f"{field} is not in canonical lowercase UUID form: {value!r}")
    return canonical


def _uuid_sort_key(value: str) -> int:
    return UUID(value).int


def _project_ref_from_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        raise BackfillError("SUPABASE_URL must be an absolute HTTP(S) URL")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise BackfillError("SUPABASE_URL must use HTTPS except for a local test server")
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise BackfillError("SUPABASE_URL must not contain credentials, a query, or a fragment")
    hostname = parsed.hostname.lower()
    if hostname.endswith(".supabase.co"):
        project_ref = hostname.removesuffix(".supabase.co").split(".")[-1]
        if not re.fullmatch(r"[a-z0-9]{20}", project_ref):
            raise BackfillError("SUPABASE_URL does not contain a valid Supabase project ref")
        return project_ref
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return "local-test"
    raise BackfillError("SUPABASE_URL must use the project *.supabase.co host")


def _rest_endpoint(supabase_url: str) -> str:
    return f"{supabase_url.rstrip('/')}/rest/v1/{TABLE_NAME}"


def _safe_http_error(response: requests.Response, operation: str) -> BackfillError:
    request_id = response.headers.get("x-request-id") or response.headers.get("cf-ray")
    suffix = f" (request {request_id})" if request_id else ""
    return BackfillError(f"{operation} failed with HTTP {response.status_code}{suffix}")


def _exact_rest_count(
    session: requests.Session,
    endpoint: str,
    timeout_seconds: float,
) -> int:
    try:
        response = session.head(
            endpoint,
            params={"select": "id"},
            headers={"Prefer": "count=exact", "Range": "0-0", "Range-Unit": "items"},
            timeout=(10, timeout_seconds),
        )
    except requests.RequestException as exc:
        raise BackfillError(f"exact-count request failed: {type(exc).__name__}") from exc
    if not 200 <= response.status_code < 300:
        raise _safe_http_error(response, "exact-count request")
    content_range = response.headers.get("content-range", "")
    match = _CONTENT_RANGE_PATTERN.fullmatch(content_range.strip())
    if match is None:
        raise BackfillError("Data API exact-count response omitted a valid Content-Range total")
    return int(match.group(1))


def _validate_source_row(raw: object, previous_id: str | None) -> dict[str, object]:
    if not isinstance(raw, dict) or set(raw) != _REQUIRED_SOURCE_FIELDS:
        raise BackfillError(
            "Data API row shape changed; expected only id, transcript_id, "
            "paragraph_number, and body_text"
        )
    paragraph_id = _canonical_uuid(raw["id"], "id")
    transcript_id = _canonical_uuid(raw["transcript_id"], f"row {paragraph_id} transcript_id")
    paragraph_number = raw["paragraph_number"]
    if (
        isinstance(paragraph_number, bool)
        or not isinstance(paragraph_number, int)
        or paragraph_number < 1
    ):
        raise BackfillError(f"row {paragraph_id} has an invalid paragraph_number")
    body_text = raw["body_text"]
    if not isinstance(body_text, str):
        raise BackfillError(f"row {paragraph_id} has a non-string body_text")
    try:
        body_text.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise BackfillError(f"row {paragraph_id} body_text is not valid UTF-8 text") from exc
    if previous_id is not None and _uuid_sort_key(paragraph_id) <= _uuid_sort_key(previous_id):
        raise BackfillError("Data API UUID keyset order was not strictly increasing")
    return {
        "id": paragraph_id,
        "transcript_id": transcript_id,
        "paragraph_number": paragraph_number,
        "body_text": body_text,
    }


def _fetch_rows(
    session: requests.Session,
    endpoint: str,
    page_size: int,
    timeout_seconds: float,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    seen_ids: set[str] = set()
    cursor: str | None = None
    page_number = 0
    while True:
        params: dict[str, str] = {
            "select": "id,transcript_id,paragraph_number,body_text",
            "order": "id.asc",
            "limit": str(page_size),
        }
        if cursor is not None:
            params["id"] = f"gt.{cursor}"
        try:
            response = session.get(
                endpoint,
                params=params,
                timeout=(10, timeout_seconds),
            )
        except requests.RequestException as exc:
            raise BackfillError(
                f"Data API page {page_number + 1} failed: {type(exc).__name__}"
            ) from exc
        if not 200 <= response.status_code < 300:
            raise _safe_http_error(response, f"Data API page {page_number + 1}")
        try:
            payload = response.json()
        except (ValueError, requests.JSONDecodeError) as exc:
            raise BackfillError(f"Data API page {page_number + 1} was not valid JSON") from exc
        if not isinstance(payload, list):
            raise BackfillError(f"Data API page {page_number + 1} was not a JSON array")
        if len(payload) > page_size:
            raise BackfillError("Data API returned more rows than the requested keyset page size")
        page_number += 1
        for raw in payload:
            row = _validate_source_row(raw, cursor)
            paragraph_id = str(row["id"])
            if paragraph_id in seen_ids:
                raise BackfillError(f"Data API returned duplicate paragraph id {paragraph_id}")
            seen_ids.add(paragraph_id)
            rows.append(row)
            cursor = paragraph_id
        print(
            f"dry-run read: page={page_number} rows={len(rows)}",
            file=sys.stderr,
            flush=True,
        )
        if len(payload) < page_size:
            break
        if not payload:
            break
    if not rows:
        raise BackfillError("Data API returned an empty transcript corpus")
    return rows


def _canonicalize_corpus(
    rows: Sequence[dict[str, object]],
) -> tuple[list[dict[str, object]], str, int]:
    ordered = sorted(
        rows,
        key=lambda row: (
            str(row["transcript_id"]),
            int(row["paragraph_number"]),
            str(row["id"]),
        ),
    )
    seen_ids: set[str] = set()
    transcript_counts: Counter[str] = Counter()
    previous_transcript: str | None = None
    previous_number: int | None = None
    digest = sha256()
    for row in ordered:
        paragraph_id = str(row["id"])
        transcript_id = str(row["transcript_id"])
        paragraph_number = int(row["paragraph_number"])
        if paragraph_id in seen_ids:
            raise BackfillError(f"duplicate paragraph id {paragraph_id}")
        seen_ids.add(paragraph_id)
        if transcript_id != previous_transcript:
            if paragraph_number != 1:
                raise BackfillError(
                    f"transcript {transcript_id} starts at paragraph {paragraph_number}, not 1"
                )
            previous_transcript = transcript_id
            previous_number = None
        if previous_number is not None and paragraph_number != previous_number + 1:
            raise BackfillError(
                f"transcript {transcript_id} has a paragraph-number gap or duplicate "
                f"at {paragraph_number}"
            )
        previous_number = paragraph_number
        transcript_counts[transcript_id] += 1
        canonical_input = {
            "body_text": row["body_text"],
            "id": paragraph_id,
            "paragraph_number": paragraph_number,
            "transcript_id": transcript_id,
        }
        digest.update(canonical_json(canonical_input).encode("utf-8"))
        digest.update(b"\n")
    return ordered, digest.hexdigest(), len(transcript_counts)


def _validate_mapping_record(record: object) -> dict[str, object]:
    if not isinstance(record, dict) or set(record) != _MAPPING_FIELDS:
        raise BackfillError("mapper output record shape changed")
    paragraph_id = _canonical_uuid(record["id"], "mapping id")
    transcript_id = _canonical_uuid(
        record["transcriptId"], f"mapping {paragraph_id} transcriptId"
    )
    paragraph_number = record["paragraphNumber"]
    if (
        isinstance(paragraph_number, bool)
        or not isinstance(paragraph_number, int)
        or paragraph_number < 1
    ):
        raise BackfillError(f"mapping {paragraph_id} has an invalid paragraphNumber")
    body_sha = record["bodySha256"]
    if not isinstance(body_sha, str) or not _SHA256_PATTERN.fullmatch(body_sha):
        raise BackfillError(f"mapping {paragraph_id} has an invalid bodySha256")
    speaker_names = record["speakerNames"]
    if not isinstance(speaker_names, list) or any(
        not isinstance(name, str) or not name for name in speaker_names
    ):
        raise BackfillError(f"mapping {paragraph_id} has invalid speakerNames")
    folded_speakers = [name.casefold() for name in speaker_names]
    if len(folded_speakers) != len(set(folded_speakers)):
        raise BackfillError(f"mapping {paragraph_id} has duplicate speakerNames")
    if UNKNOWN_SPEAKER in speaker_names and len(speaker_names) < 2:
        raise BackfillError(
            f"mapping {paragraph_id} stores the unknown sentinel without a proved speaker"
        )
    for field in ("beforeSpeaker", "afterSpeaker"):
        if record[field] is not None and (
            not isinstance(record[field], str) or not record[field]
        ):
            raise BackfillError(f"mapping {paragraph_id} has invalid {field}")
    evidence_modes = record["evidenceModes"]
    if not isinstance(evidence_modes, list) or any(
        mode not in _EVIDENCE_MODE_ORDER for mode in evidence_modes
    ):
        raise BackfillError(f"mapping {paragraph_id} has invalid evidenceModes")
    expected_mode_order = [mode for mode in _EVIDENCE_MODE_ORDER if mode in evidence_modes]
    if evidence_modes != expected_mode_order or len(evidence_modes) != len(set(evidence_modes)):
        raise BackfillError(f"mapping {paragraph_id} evidenceModes are not canonical")
    suspicious_codes = record["suspiciousCodes"]
    if not isinstance(suspicious_codes, list) or any(
        not isinstance(code, str) or not code for code in suspicious_codes
    ):
        raise BackfillError(f"mapping {paragraph_id} has invalid suspiciousCodes")
    if len(suspicious_codes) != len(set(suspicious_codes)):
        raise BackfillError(f"mapping {paragraph_id} has duplicate suspiciousCodes")
    if bool(suspicious_codes) != ("suspicious" in evidence_modes):
        raise BackfillError(f"mapping {paragraph_id} suspicious evidence is inconsistent")
    if (len(speaker_names) > 1) != ("mixed" in evidence_modes):
        raise BackfillError(f"mapping {paragraph_id} mixed evidence is inconsistent")
    return {
        "id": paragraph_id,
        "transcriptId": transcript_id,
        "paragraphNumber": paragraph_number,
        "bodySha256": body_sha,
        "speakerNames": speaker_names,
        "beforeSpeaker": record["beforeSpeaker"],
        "afterSpeaker": record["afterSpeaker"],
        "evidenceModes": evidence_modes,
        "suspiciousCodes": suspicious_codes,
    }


def _mapping_sort_key(record: Mapping[str, object]) -> tuple[str, int, str]:
    return (
        str(record["transcriptId"]),
        int(record["paragraphNumber"]),
        str(record["id"]),
    )


def _validate_mapping_against_corpus(
    rows: Sequence[dict[str, object]],
    records: Sequence[dict[str, object]],
) -> None:
    if len(rows) != len(records):
        raise BackfillError("mapper output count does not equal corpus row count")
    if list(records) != sorted(records, key=_mapping_sort_key):
        raise BackfillError("mapper output is not in canonical transcript order")
    for row, record in zip(rows, records):
        paragraph_id = str(row["id"])
        if record["id"] != paragraph_id:
            raise BackfillError("mapper output paragraph order or identity changed")
        if record["transcriptId"] != row["transcript_id"]:
            raise BackfillError(f"mapper changed transcript identity for {paragraph_id}")
        if record["paragraphNumber"] != row["paragraph_number"]:
            raise BackfillError(f"mapper changed paragraph order for {paragraph_id}")
        expected_body_sha = _sha256_bytes(str(row["body_text"]).encode("utf-8"))
        if record["bodySha256"] != expected_body_sha:
            raise BackfillError(f"mapper body hash mismatch for {paragraph_id}")


def _fixture_checks(records: Sequence[dict[str, object]]) -> list[dict[str, object]]:
    by_id = {str(record["id"]): record for record in records}
    checks: list[dict[str, object]] = []
    for fixture in _REFERENCE_FIXTURES:
        paragraph_id = str(fixture["id"])
        record = by_id.get(paragraph_id)
        observed = None if record is None else record["speakerNames"]
        passed = observed == fixture["expectedSpeakerNames"]
        checks.append(
            {
                "name": fixture["name"],
                "id": paragraph_id,
                "expectedSpeakerNames": fixture["expectedSpeakerNames"],
                "observedSpeakerNames": observed,
                "passed": passed,
            }
        )
    failures = [check for check in checks if not check["passed"]]
    if failures:
        failed_ids = ", ".join(str(check["id"]) for check in failures)
        raise BackfillError(f"required screenshot fixture verification failed: {failed_ids}")
    return checks


def _atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        with temporary.open("wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        with suppress(FileNotFoundError):
            temporary.unlink()


def _write_ndjson(path: Path, records: Iterable[Mapping[str, object]]) -> dict[str, object]:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    digest = sha256()
    size = 0
    line_count = 0
    try:
        with temporary.open("wb") as handle:
            for record in records:
                line = (canonical_json(record) + "\n").encode("utf-8")
                handle.write(line)
                digest.update(line)
                size += len(line)
                line_count += 1
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        with suppress(FileNotFoundError):
            temporary.unlink()
    return {"sha256": digest.hexdigest(), "bytes": size, "lineCount": line_count}


def _write_canonical_json(path: Path, value: object) -> dict[str, object]:
    content = (canonical_json(value) + "\n").encode("utf-8")
    _atomic_write_bytes(path, content)
    return {
        "sha256": _sha256_bytes(content),
        "bytes": len(content),
        "lineCount": 1,
    }


def _code_hash_records() -> list[dict[str, str]]:
    files = (
        (SCRIPT_PATH, "runner"),
        (MAPPER_PATH, "mapper"),
        (RECOMPUTE_PATH, "complete-transcript recompute runner"),
        (REQUIREMENTS_PATH, "pinned operator dependencies"),
        (MIGRATION_PATH, "column migration"),
        (ROLLBACK_PATH, "inert rollback"),
    )
    records: list[dict[str, str]] = []
    for path, purpose in files:
        _require_file(path, purpose)
        records.append(
            {
                "path": _relative_repo_path(path),
                "sha256": _sha256_file(path),
            }
        )
    return records


def _build_artifacts(
    rows: Sequence[dict[str, object]],
    artifact_dir: Path,
    source: Mapping[str, object],
) -> str:
    canonical_rows, corpus_sha, transcript_count = _canonicalize_corpus(rows)
    mapper_results, mapper_stats = map_corpus(canonical_rows)
    records = [_validate_mapping_record(result.to_record()) for result in mapper_results]
    _validate_mapping_against_corpus(canonical_rows, records)
    fixture_checks = _fixture_checks(records)

    stats = mapper_stats.to_record()
    if stats["processedParagraphs"] != len(records):
        raise BackfillError("mapper paragraph stats do not match mapping output")
    if stats["processedTranscripts"] != transcript_count:
        raise BackfillError("mapper transcript stats do not match the complete corpus")

    evidence_counts = Counter(
        mode for record in records for mode in record["evidenceModes"]  # type: ignore[union-attr]
    )
    suspicious_code_counts = Counter(
        code for record in records for code in record["suspiciousCodes"]  # type: ignore[union-attr]
    )
    suspicious_records = [record for record in records if record["suspiciousCodes"]]
    empty_speaker_count = sum(not record["speakerNames"] for record in records)
    known_single_only_count = sum(
        len(record["speakerNames"]) == 1
        and UNKNOWN_SPEAKER not in record["speakerNames"]
        for record in records
    )
    known_multiple_only_count = sum(
        len([name for name in record["speakerNames"] if name != UNKNOWN_SPEAKER]) > 1
        and UNKNOWN_SPEAKER not in record["speakerNames"]
        for record in records
    )
    known_and_unknown_count = sum(
        UNKNOWN_SPEAKER in record["speakerNames"] for record in records
    )
    is_live_packet = source.get("projectRef") != "local-test"
    exact_speaker_proofs = (
        audited_exact_speaker_proofs(canonical_rows) if is_live_packet else []
    )

    verification = {
        "formatVersion": FORMAT_VERSION,
        "auditedExactSpeakerProofs": exact_speaker_proofs,
        "fixtureChecks": fixture_checks,
        "invariants": {
            "bodyTextExcludedFromArtifacts": True,
            "completeTranscriptOrderingValidated": True,
            "duplicateParagraphIds": 0,
            "exactSpeakerAllowlistProofsFrozen": is_live_packet,
            "paragraphNumberGaps": 0,
            "unknownSentinelStoredWithoutKnownSpeaker": 0,
        },
        "mappingCounts": {
            **stats,
            "emptySpeakerArrays": empty_speaker_count,
            "knownSingleOnlyParagraphs": known_single_only_count,
            "knownMultipleOnlyParagraphs": known_multiple_only_count,
            "knownAndUnknownParagraphs": known_and_unknown_count,
            "suspiciousRecords": len(suspicious_records),
        },
        "evidenceModeCounts": {
            mode: evidence_counts.get(mode, 0) for mode in _EVIDENCE_MODE_ORDER
        },
        "suspiciousCodeCounts": dict(sorted(suspicious_code_counts.items())),
        "sourceScan": dict(source),
    }

    artifact_dir = artifact_dir.resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    ledger_path = artifact_dir / LEDGER_FILE
    if ledger_path.exists() and ledger_path.stat().st_size:
        raise BackfillError(
            "refusing to replace frozen artifacts beside a non-empty apply ledger; "
            "use a new artifact directory"
        )

    mapping_meta = _write_ndjson(artifact_dir / MAPPING_FILE, records)
    suspicious_meta = _write_ndjson(artifact_dir / SUSPICIOUS_FILE, suspicious_records)
    verification_meta = _write_canonical_json(
        artifact_dir / VERIFICATION_FILE, verification
    )
    artifacts = {
        MAPPING_FILE: mapping_meta,
        SUSPICIOUS_FILE: suspicious_meta,
        VERIFICATION_FILE: verification_meta,
    }
    manifest = {
        "formatVersion": FORMAT_VERSION,
        "purpose": "transcript-speaker-backfill",
        "source": dict(source),
        "corpusInput": {
            "canonicalization": (
                "UTF-8 canonical JSON lines sorted by transcript_id, "
                "paragraph_number, id; includes body_text"
            ),
            "sha256": corpus_sha,
            "paragraphs": len(records),
            "transcripts": transcript_count,
        },
        "expectedCounts": verification["mappingCounts"],
        "fixtureChecks": fixture_checks,
        "artifacts": artifacts,
        "codeFiles": _code_hash_records(),
        "approval": {
            "environmentVariable": APPROVAL_ENV,
            "markerPrefix": APPROVAL_PREFIX,
        },
        "writeContract": {
            "column": "public.transcript_paragraphs.speaker_names",
            "maximumRowsPerBatch": MAX_BATCH_SIZE,
            "transcriptCompleteBatches": True,
            "schemaChanges": False,
        },
    }
    manifest_bytes = (canonical_json(manifest) + "\n").encode("utf-8")
    _atomic_write_bytes(artifact_dir / MANIFEST_FILE, manifest_bytes)
    manifest_sha = _sha256_bytes(manifest_bytes)
    _atomic_write_bytes(
        artifact_dir / MANIFEST_SHA_FILE,
        (manifest_sha + "\n").encode("ascii"),
    )
    return manifest_sha


def run_dry_run(args: argparse.Namespace) -> int:
    _verify_runtime_dependencies(require_psycopg=False)
    supabase_url = os.environ.get("SUPABASE_URL", "").strip()
    publishable_key = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip()
    if not supabase_url:
        raise BackfillError("SUPABASE_URL is required for dry-run")
    if not publishable_key:
        raise BackfillError("SUPABASE_PUBLISHABLE_KEY is required for dry-run")
    project_ref = _project_ref_from_url(supabase_url)
    endpoint = _rest_endpoint(supabase_url)
    with requests.Session() as session:
        session.headers.update(
            {
                "Accept": "application/json",
                "Authorization": f"Bearer {publishable_key}",
                "apikey": publishable_key,
                "User-Agent": "transcript-speaker-backfill/1",
            }
        )
        count_before = _exact_rest_count(session, endpoint, args.timeout_seconds)
        rows = _fetch_rows(session, endpoint, args.page_size, args.timeout_seconds)
        count_after = _exact_rest_count(session, endpoint, args.timeout_seconds)
    if count_before != count_after or count_after != len(rows):
        raise BackfillError(
            "corpus row count changed during the read-only scan or did not match fetched rows"
        )
    source = {
        "access": "publishable-key-read-only-data-api",
        "countAfter": count_after,
        "countBefore": count_before,
        "firstId": rows[0]["id"],
        "lastId": rows[-1]["id"],
        "projectRef": project_ref,
        "table": f"public.{TABLE_NAME}",
    }
    manifest_sha = _build_artifacts(rows, args.artifact_dir, source)
    print(f"dry-run complete: paragraphs={len(rows)}")
    print(f"artifact directory: {args.artifact_dir.resolve()}")
    print(f"manifest SHA-256: {manifest_sha}")
    print(f"required backfill marker: {APPROVAL_PREFIX}{manifest_sha}")
    print("no database writes were performed")
    return 0


def _load_canonical_json(path: Path) -> object:
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise BackfillError(f"could not read artifact {path.name}: {type(exc).__name__}") from exc
    try:
        value = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BackfillError(f"artifact {path.name} is not valid UTF-8 JSON") from exc
    expected = (canonical_json(value) + "\n").encode("utf-8")
    if content != expected:
        raise BackfillError(f"artifact {path.name} is not in canonical JSON form")
    return value


def _load_manifest(artifact_dir: Path) -> tuple[dict[str, object], str]:
    manifest_path = artifact_dir / MANIFEST_FILE
    sha_path = artifact_dir / MANIFEST_SHA_FILE
    if not manifest_path.is_file() or not sha_path.is_file():
        raise BackfillError("frozen run-manifest.json and run-manifest.sha256 are required")
    try:
        sha_text = sha_path.read_text(encoding="ascii")
    except (OSError, UnicodeDecodeError) as exc:
        raise BackfillError("run-manifest.sha256 is not readable ASCII") from exc
    if not re.fullmatch(r"[0-9a-f]{64}\n", sha_text):
        raise BackfillError("run-manifest.sha256 has an invalid format")
    expected_sha = sha_text.strip()
    actual_sha = _sha256_file(manifest_path)
    if actual_sha != expected_sha:
        raise BackfillError("run manifest hash does not match run-manifest.sha256")
    loaded = _load_canonical_json(manifest_path)
    if not isinstance(loaded, dict):
        raise BackfillError("run manifest root must be an object")
    if loaded.get("formatVersion") != FORMAT_VERSION:
        raise BackfillError("unsupported run manifest formatVersion")
    if loaded.get("purpose") != "transcript-speaker-backfill":
        raise BackfillError("run manifest purpose is not transcript-speaker-backfill")
    return loaded, expected_sha


def _artifact_meta(manifest: Mapping[str, object], filename: str) -> Mapping[str, object]:
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict) or set(artifacts) != {
        MAPPING_FILE,
        SUSPICIOUS_FILE,
        VERIFICATION_FILE,
    }:
        raise BackfillError("run manifest artifact set is invalid")
    metadata = artifacts.get(filename)
    if not isinstance(metadata, dict):
        raise BackfillError(f"run manifest metadata for {filename} is invalid")
    return metadata


def _verify_file_meta(path: Path, metadata: Mapping[str, object]) -> None:
    if set(metadata) != {"sha256", "bytes", "lineCount"}:
        raise BackfillError(f"artifact metadata shape changed for {path.name}")
    if not path.is_file():
        raise BackfillError(f"required frozen artifact is missing: {path.name}")
    expected_sha = metadata.get("sha256")
    expected_bytes = metadata.get("bytes")
    expected_lines = metadata.get("lineCount")
    if not isinstance(expected_sha, str) or not _SHA256_PATTERN.fullmatch(expected_sha):
        raise BackfillError(f"artifact hash is invalid for {path.name}")
    if isinstance(expected_bytes, bool) or not isinstance(expected_bytes, int):
        raise BackfillError(f"artifact byte count is invalid for {path.name}")
    if isinstance(expected_lines, bool) or not isinstance(expected_lines, int):
        raise BackfillError(f"artifact line count is invalid for {path.name}")
    if path.stat().st_size != expected_bytes or _sha256_file(path) != expected_sha:
        raise BackfillError(f"frozen artifact integrity check failed: {path.name}")
    with path.open("rb") as handle:
        actual_lines = sum(1 for _ in handle)
    if actual_lines != expected_lines:
        raise BackfillError(f"frozen artifact line count changed: {path.name}")


def _load_mapping_records(path: Path) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.endswith("\n"):
                    raise BackfillError(f"{path.name} line {line_number} lacks a newline")
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise BackfillError(
                        f"{path.name} line {line_number} is invalid JSON"
                    ) from exc
                if line != canonical_json(raw) + "\n":
                    raise BackfillError(
                        f"{path.name} line {line_number} is not canonical JSON"
                    )
                records.append(_validate_mapping_record(raw))
    except (OSError, UnicodeDecodeError) as exc:
        raise BackfillError(f"could not read {path.name}: {type(exc).__name__}") from exc
    if not records:
        raise BackfillError("proposed mapping artifact is empty")
    if records != sorted(records, key=_mapping_sort_key):
        raise BackfillError("proposed mapping artifact is not canonically ordered")
    ids = [str(record["id"]) for record in records]
    if len(ids) != len(set(ids)):
        raise BackfillError("proposed mapping artifact contains duplicate paragraph ids")
    seen_transcripts: set[str] = set()
    current_transcript: str | None = None
    previous_number: int | None = None
    for record in records:
        transcript_id = str(record["transcriptId"])
        number = int(record["paragraphNumber"])
        if transcript_id != current_transcript:
            if transcript_id in seen_transcripts:
                raise BackfillError("a transcript is split across the mapping artifact")
            seen_transcripts.add(transcript_id)
            current_transcript = transcript_id
            previous_number = None
            if number != 1:
                raise BackfillError(f"transcript {transcript_id} does not start at paragraph 1")
        if previous_number is not None and number != previous_number + 1:
            raise BackfillError(f"transcript {transcript_id} is not complete and contiguous")
        previous_number = number
    return records


def _verify_frozen_packet(
    artifact_dir: Path,
) -> tuple[dict[str, object], str, list[dict[str, object]]]:
    manifest, manifest_sha = _load_manifest(artifact_dir)
    for filename in (MAPPING_FILE, SUSPICIOUS_FILE, VERIFICATION_FILE):
        _verify_file_meta(
            artifact_dir / filename,
            _artifact_meta(manifest, filename),
        )
    code_files = manifest.get("codeFiles")
    if not isinstance(code_files, list) or not code_files:
        raise BackfillError("run manifest codeFiles are invalid")
    expected_paths = {
        _relative_repo_path(SCRIPT_PATH),
        _relative_repo_path(MAPPER_PATH),
        _relative_repo_path(RECOMPUTE_PATH),
        _relative_repo_path(REQUIREMENTS_PATH),
        _relative_repo_path(MIGRATION_PATH),
        _relative_repo_path(ROLLBACK_PATH),
    }
    observed_paths: set[str] = set()
    for item in code_files:
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            raise BackfillError("run manifest code file record is invalid")
        relative = item["path"]
        expected_sha = item["sha256"]
        if not isinstance(relative, str) or relative not in expected_paths:
            raise BackfillError("run manifest contains an unexpected code file path")
        if not isinstance(expected_sha, str) or not _SHA256_PATTERN.fullmatch(expected_sha):
            raise BackfillError(f"run manifest has an invalid code hash for {relative}")
        path = (REPO_ROOT / relative).resolve()
        try:
            path.relative_to(REPO_ROOT)
        except ValueError as exc:
            raise BackfillError("run manifest code path escaped the repository") from exc
        if not path.is_file() or _sha256_file(path) != expected_sha:
            raise BackfillError(f"approved code hash changed: {relative}")
        observed_paths.add(relative)
    if observed_paths != expected_paths:
        raise BackfillError("run manifest code file set is incomplete")

    records = _load_mapping_records(artifact_dir / MAPPING_FILE)
    expected_counts = manifest.get("expectedCounts")
    if not isinstance(expected_counts, dict):
        raise BackfillError("run manifest expectedCounts are invalid")
    if expected_counts.get("processedParagraphs") != len(records):
        raise BackfillError("mapping row count does not match the approved manifest")
    transcript_count = len({str(record["transcriptId"]) for record in records})
    corpus_input = manifest.get("corpusInput")
    if not isinstance(corpus_input, dict):
        raise BackfillError("run manifest corpusInput is invalid")
    if corpus_input.get("paragraphs") != len(records):
        raise BackfillError("approved corpus paragraph count is inconsistent")
    if corpus_input.get("transcripts") != transcript_count:
        raise BackfillError("approved corpus transcript count is inconsistent")

    suspicious_records = [record for record in records if record["suspiciousCodes"]]
    expected_suspicious = b"".join(
        (canonical_json(record) + "\n").encode("utf-8") for record in suspicious_records
    )
    if (artifact_dir / SUSPICIOUS_FILE).read_bytes() != expected_suspicious:
        raise BackfillError("suspicious artifact does not exactly match proposed mapping")
    verification = _load_canonical_json(artifact_dir / VERIFICATION_FILE)
    if not isinstance(verification, dict):
        raise BackfillError("verification artifact root must be an object")
    fixture_checks = verification.get("fixtureChecks")
    if not isinstance(fixture_checks, list) or not fixture_checks or any(
        not isinstance(check, dict) or check.get("passed") is not True
        for check in fixture_checks
    ):
        raise BackfillError("approved verification does not contain passing fixture checks")
    if manifest.get("fixtureChecks") != fixture_checks:
        raise BackfillError("manifest and verification fixture checks differ")
    source = manifest.get("source")
    if not isinstance(source, dict):
        raise BackfillError("run manifest source is invalid")
    proofs = verification.get("auditedExactSpeakerProofs")
    invariants = verification.get("invariants")
    if source.get("projectRef") != "local-test":
        if (
            not isinstance(invariants, dict)
            or invariants.get("exactSpeakerAllowlistProofsFrozen") is not True
            or not isinstance(proofs, list)
            or not proofs
        ):
            raise BackfillError("approved packet lacks exact-speaker proof provenance")
        mapping_by_id = {str(record["id"]): record for record in records}
        folded_labels: list[str] = []
        for proof in proofs:
            if not isinstance(proof, dict) or set(proof) != {
                "foldedLabel",
                "occurrenceCount",
                "proofKind",
                "samples",
            }:
                raise BackfillError("exact-speaker proof record shape changed")
            folded_label = proof.get("foldedLabel")
            occurrence_count = proof.get("occurrenceCount")
            samples = proof.get("samples")
            if (
                not isinstance(folded_label, str)
                or not folded_label
                or proof.get("proofKind") != "audited_exact_allowlist"
                or isinstance(occurrence_count, bool)
                or not isinstance(occurrence_count, int)
                or occurrence_count < 1
                or not isinstance(samples, list)
                or not 1 <= len(samples) <= 3
            ):
                raise BackfillError("exact-speaker proof record is invalid")
            folded_labels.append(folded_label)
            for sample in samples:
                if not isinstance(sample, dict) or set(sample) != {
                    "bodySha256",
                    "canonicalSpeaker",
                    "lineNumber",
                    "paragraphId",
                    "paragraphNumber",
                    "rawLabel",
                    "transcriptId",
                }:
                    raise BackfillError("exact-speaker proof sample shape changed")
                paragraph_id = sample.get("paragraphId")
                record = mapping_by_id.get(str(paragraph_id))
                if (
                    record is None
                    or sample.get("bodySha256") != record["bodySha256"]
                    or sample.get("transcriptId") != record["transcriptId"]
                    or sample.get("paragraphNumber") != record["paragraphNumber"]
                    or isinstance(sample.get("lineNumber"), bool)
                    or not isinstance(sample.get("lineNumber"), int)
                    or int(sample["lineNumber"]) < 1
                    or not isinstance(sample.get("rawLabel"), str)
                    or not sample["rawLabel"]
                    or not isinstance(sample.get("canonicalSpeaker"), str)
                    or not sample["canonicalSpeaker"]
                ):
                    raise BackfillError("exact-speaker proof sample does not bind the mapping")
        if folded_labels != sorted(set(folded_labels)):
            raise BackfillError("exact-speaker proof labels are not unique and sorted")
    return manifest, manifest_sha, records


def _database_project_ref(conninfo: Mapping[str, str]) -> str | None:
    hostname = conninfo.get("host", "").lower()
    username = conninfo.get("user", "").lower()
    direct = re.fullmatch(r"db\.([a-z0-9]{20})\.supabase\.co", hostname)
    if direct and username == "postgres":
        return direct.group(1)
    pooler_host = re.fullmatch(
        r"[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pooler\.supabase\.com",
        hostname,
    )
    pooler_user = re.fullmatch(r"postgres\.([a-z0-9]{20})", username)
    if pooler_host and pooler_user:
        return pooler_user.group(1)
    return None


def _validate_database_conninfo(
    conninfo: Mapping[str, str], expected_project_ref: str
) -> None:
    routing_overrides = [
        key
        for key in ("hostaddr", "service", "servicefile")
        if key in conninfo
    ]
    if routing_overrides:
        raise BackfillError(
            "DATABASE_URL must not use libpq routing overrides: "
            + ", ".join(routing_overrides)
        )
    if conninfo.get("port") != "5432":
        raise BackfillError(
            "DATABASE_URL apply target must use direct/session port 5432"
        )
    if conninfo.get("dbname") != "postgres":
        raise BackfillError("DATABASE_URL apply target database must be postgres")
    if conninfo.get("sslmode") not in {"require", "verify-ca", "verify-full"}:
        raise BackfillError(
            "DATABASE_URL must explicitly require TLS with sslmode=require or stronger"
        )
    observed_project_ref = _database_project_ref(conninfo)
    if observed_project_ref is None:
        raise BackfillError(
            "DATABASE_URL must use the exact Supabase direct host/user or an official "
            "session-pooler host/user pair"
        )
    if observed_project_ref != expected_project_ref:
        raise BackfillError("DATABASE_URL project ref does not match the approved dry-run")


def _validate_database_target(database_url: str, expected_project_ref: str) -> None:
    ambient_routing = [
        key
        for key in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE")
        if os.environ.get(key)
    ]
    if ambient_routing:
        raise BackfillError(
            "apply environment must not contain libpq routing overrides: "
            + ", ".join(ambient_routing)
        )
    try:
        from psycopg.conninfo import conninfo_to_dict

        conninfo = conninfo_to_dict(database_url)
    except Exception as exc:
        raise BackfillError("DATABASE_URL is not a valid PostgreSQL connection string") from exc
    _validate_database_conninfo(conninfo, expected_project_ref)


def _advisory_lock_key(project_ref: str) -> int:
    unsigned = int.from_bytes(
        sha256(f"transcript-speaker-backfill:v1:{project_ref}".encode("ascii")).digest()[:8],
        "big",
    )
    return unsigned if unsigned < 2**63 else unsigned - 2**64


def _schema_preflight(cursor: Any) -> None:
    cursor.execute(
        """
        SELECT c.relrowsecurity
        FROM pg_catalog.pg_class AS c
        WHERE c.oid = pg_catalog.to_regclass('public.transcript_paragraphs')
        """
    )
    rls_row = cursor.fetchone()
    if rls_row is None or rls_row[0] is not True:
        raise BackfillError("RLS is not enabled on public.transcript_paragraphs")
    cursor.execute(
        """
        SELECT
          pg_catalog.format_type(a.atttypid, a.atttypmod),
          a.attnotnull,
          pg_catalog.pg_get_expr(d.adbin, d.adrelid)
        FROM pg_catalog.pg_attribute AS a
        LEFT JOIN pg_catalog.pg_attrdef AS d
          ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = pg_catalog.to_regclass('public.transcript_paragraphs')
          AND a.attname = 'speaker_names'
          AND a.attnum > 0
          AND NOT a.attisdropped
        """
    )
    row = cursor.fetchone()
    if row is None or row[0] != "text[]" or row[1] is not False or row[2] is not None:
        raise BackfillError(
            "speaker_names schema is absent or is not nullable text[] without a default"
        )
    cursor.execute(
        """
        SELECT pg_catalog.md5(p.prosrc), p.proconfig
        FROM pg_catalog.pg_proc AS p
        JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
        WHERE p.oid = pg_catalog.to_regprocedure('public.body_search_vectors_trigger()')
          AND p.prokind = 'f'
          AND p.pronargs = 0
          AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
          AND l.lanname = 'plpgsql'
          AND p.provolatile = 'v'
          AND NOT p.prosecdef
        """
    )
    function_row = cursor.fetchone()
    if (
        function_row is None
        or function_row[0] != EXPECTED_VECTOR_FUNCTION_EXACT_MD5
        or list(function_row[1] or []) != EXPECTED_VECTOR_FUNCTION_CONFIG
    ):
        raise BackfillError(
            "body_search_vectors_trigger() body, search_path, or properties drifted"
        )
    cursor.execute(
        """
        SELECT a.attname, a.attnum
        FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = pg_catalog.to_regclass('public.transcript_paragraphs')
          AND a.attname IN ('body_text', 'fts_expansion_src', 'fts_core')
          AND a.attnum > 0
          AND NOT a.attisdropped
        """
    )
    source_attnums = {str(name): int(attnum) for name, attnum in cursor.fetchall()}
    if set(source_attnums) != {"body_text", "fts_expansion_src", "fts_core"}:
        raise BackfillError("transcript search-vector source/touch columns are missing")
    expected_trigger_columns = (
        f"{source_attnums['body_text']} {source_attnums['fts_expansion_src']} "
        f"{source_attnums['fts_core']}"
    )
    cursor.execute(
        """
        SELECT
          t.tgtype,
          t.tgenabled::text,
          t.tgfoid = pg_catalog.to_regprocedure('public.body_search_vectors_trigger()'),
          COALESCE(t.tgattr::text, ''),
          t.tgqual IS NOT NULL,
          t.tgnargs,
          pg_catalog.pg_get_triggerdef(t.oid, true)
        FROM pg_catalog.pg_trigger AS t
        WHERE t.tgrelid = pg_catalog.to_regclass('public.transcript_paragraphs')
          AND t.tgname = 'trg_transcript_search_vectors'
          AND NOT t.tgisinternal
        """
    )
    trigger_row = cursor.fetchone()
    trigger_definition = "" if trigger_row is None else str(trigger_row[6])
    normalized_trigger = " ".join(trigger_definition.lower().split())
    if (
        trigger_row is None
        or trigger_row[0] != 23
        or trigger_row[1] != "O"
        or trigger_row[2] is not True
        or trigger_row[3] != expected_trigger_columns
        or trigger_row[4] is not False
        or trigger_row[5] != 0
        or "before insert or update of body_text, fts_expansion_src, fts_core on"
        not in normalized_trigger
        or re.search(
            r"execute function (?:public\.)?body_search_vectors_trigger\(\)",
            normalized_trigger,
        )
        is None
    ):
        raise BackfillError(
            "search-vector trigger catalog shape is not the exact approved narrowed form"
        )
    cursor.execute(
        """
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_index AS i
          WHERE i.indrelid = pg_catalog.to_regclass('public.transcript_paragraphs')
            AND pg_catalog.strpos(
              pg_catalog.lower(pg_catalog.pg_get_indexdef(i.indexrelid)),
              'speaker_names'
            ) > 0
        )
        """
    )
    if cursor.fetchone()[0]:
        raise BackfillError("speaker_names has an unexpected index")


def _database_counts(cursor: Any) -> tuple[int, int, int, int]:
    cursor.execute(
        """
        SELECT
          count(*)::bigint,
          count(DISTINCT transcript_id)::bigint,
          count(*) FILTER (WHERE transcript_id IS NULL)::bigint,
          count(*) FILTER (WHERE speaker_names IS NOT NULL)::bigint
        FROM public.transcript_paragraphs
        """
    )
    row = cursor.fetchone()
    return int(row[0]), int(row[1]), int(row[2]), int(row[3])


def _existing_speaker_values_preflight(
    cursor: Any,
    records: Sequence[dict[str, object]],
) -> int:
    """Reject any non-NULL attribution drift before the first update runs."""

    expected = {
        str(record["id"]): list(record["speakerNames"]) for record in records
    }
    cursor.execute(
        """
        SELECT id::text, speaker_names
        FROM public.transcript_paragraphs
        WHERE speaker_names IS NOT NULL
        ORDER BY id
        """
    )
    checked = 0
    for paragraph_id, current_speakers in cursor:
        desired = expected.get(str(paragraph_id))
        if desired is None or list(current_speakers) != desired:
            raise BackfillError(
                f"existing speaker_names drift detected for paragraph {paragraph_id}; "
                "no backfill rows were updated in this run"
            )
        checked += 1
    return checked


def _transcript_complete_batches(
    records: Sequence[dict[str, object]], batch_size: int
) -> Iterator[tuple[int, list[dict[str, object]]]]:
    groups: list[list[dict[str, object]]] = []
    current: list[dict[str, object]] = []
    current_transcript: str | None = None
    for record in records:
        transcript_id = str(record["transcriptId"])
        if current and transcript_id != current_transcript:
            groups.append(current)
            current = []
        current_transcript = transcript_id
        current.append(record)
    if current:
        groups.append(current)
    batch: list[dict[str, object]] = []
    batch_index = 0
    for group in groups:
        if len(group) > batch_size:
            raise BackfillError(
                f"transcript {group[0]['transcriptId']} has {len(group)} rows, "
                f"exceeding batch size {batch_size}"
            )
        if batch and len(batch) + len(group) > batch_size:
            yield batch_index, batch
            batch_index += 1
            batch = []
        batch.extend(group)
    if batch:
        yield batch_index, batch


def _batch_sha(records: Sequence[Mapping[str, object]]) -> str:
    digest = sha256()
    for record in records:
        digest.update((canonical_json(record) + "\n").encode("utf-8"))
    return digest.hexdigest()


def _load_existing_ledger(
    path: Path,
    manifest_sha: str,
    batches: Sequence[tuple[int, list[dict[str, object]]]],
) -> set[int]:
    if not path.exists():
        return set()
    required_fields = {
        "batchIndex",
        "batchSha256",
        "committedAt",
        "firstParagraphId",
        "lastParagraphId",
        "manifestSha256",
        "paragraphs",
        "transcripts",
        "unchangedRows",
        "updatedRows",
    }
    completed: set[int] = set()
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.endswith("\n"):
                    raise BackfillError(f"apply ledger line {line_number} is incomplete")
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise BackfillError(f"apply ledger line {line_number} is invalid") from exc
                if not isinstance(record, dict) or set(record) != required_fields:
                    raise BackfillError(f"apply ledger line {line_number} shape is invalid")
                if record.get("manifestSha256") != manifest_sha:
                    raise BackfillError("apply ledger belongs to a different frozen manifest")
                batch_index = record.get("batchIndex")
                if (
                    isinstance(batch_index, bool)
                    or not isinstance(batch_index, int)
                    or batch_index != line_number - 1
                    or batch_index >= len(batches)
                    or batch_index in completed
                ):
                    raise BackfillError(
                        "apply ledger batch indexes must be a unique contiguous prefix"
                    )
                expected_index, batch = batches[batch_index]
                if expected_index != batch_index:
                    raise BackfillError("internal batch indexing is not canonical")
                transcript_count = len(
                    {str(item["transcriptId"]) for item in batch}
                )
                integer_expectations = {
                    "paragraphs": len(batch),
                    "transcripts": transcript_count,
                }
                for field, expected in integer_expectations.items():
                    value = record.get(field)
                    if isinstance(value, bool) or not isinstance(value, int) or value != expected:
                        raise BackfillError(
                            f"apply ledger line {line_number} has invalid {field}"
                        )
                updated = record.get("updatedRows")
                unchanged = record.get("unchangedRows")
                if (
                    isinstance(updated, bool)
                    or not isinstance(updated, int)
                    or updated < 0
                    or isinstance(unchanged, bool)
                    or not isinstance(unchanged, int)
                    or unchanged < 0
                    or updated + unchanged != len(batch)
                ):
                    raise BackfillError(
                        f"apply ledger line {line_number} row counts are invalid"
                    )
                committed_at = record.get("committedAt")
                if not isinstance(committed_at, str) or not committed_at.endswith("Z"):
                    raise BackfillError(
                        f"apply ledger line {line_number} committedAt is invalid"
                    )
                try:
                    datetime.fromisoformat(committed_at.removesuffix("Z") + "+00:00")
                except ValueError as exc:
                    raise BackfillError(
                        f"apply ledger line {line_number} committedAt is invalid"
                    ) from exc
                if (
                    record.get("batchSha256") != _batch_sha(batch)
                    or record.get("firstParagraphId") != batch[0]["id"]
                    or record.get("lastParagraphId") != batch[-1]["id"]
                ):
                    raise BackfillError(
                        f"apply ledger line {line_number} does not match its frozen batch"
                    )
                completed.add(batch_index)
    except (OSError, UnicodeDecodeError) as exc:
        raise BackfillError(f"could not validate apply ledger: {type(exc).__name__}") from exc
    return completed


def _append_ledger(path: Path, record: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = (canonical_json(record) + "\n").encode("utf-8")
    try:
        with path.open("ab") as handle:
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        raise BackfillError(
            "database batch committed but apply ledger could not be fsynced; rerun is safe"
        ) from exc


def _verify_batch_rows(
    database_rows: Sequence[Sequence[object]],
    records: Sequence[dict[str, object]],
    *,
    require_desired_speakers: bool = False,
    allow_speaker_replacement: bool = False,
) -> None:
    if require_desired_speakers and allow_speaker_replacement:
        raise BackfillError(
            "row verification cannot require and replace speaker_names simultaneously"
        )
    expected = {str(record["id"]): record for record in records}
    if len(database_rows) != len(expected):
        raise BackfillError("database transcript rows differ from the frozen batch")
    observed_ids: set[str] = set()
    for row in database_rows:
        paragraph_id = str(row[0])
        transcript_id = str(row[1])
        paragraph_number = int(row[2])
        body_text = row[3]
        if not isinstance(body_text, str):
            raise BackfillError(f"database paragraph {paragraph_id} has non-text body_text")
        record = expected.get(paragraph_id)
        if record is None:
            raise BackfillError("database contains a paragraph absent from the frozen transcript")
        if transcript_id != record["transcriptId"]:
            raise BackfillError(f"transcript_id drift detected for paragraph {paragraph_id}")
        if paragraph_number != record["paragraphNumber"]:
            raise BackfillError(f"paragraph_number drift detected for paragraph {paragraph_id}")
        if _sha256_bytes(body_text.encode("utf-8")) != record["bodySha256"]:
            raise BackfillError(f"body_text drift detected for paragraph {paragraph_id}")
        current_speakers = row[4]
        desired_speakers = list(record["speakerNames"])
        if require_desired_speakers and (
            current_speakers is None or list(current_speakers) != desired_speakers
        ):
            raise BackfillError(
                f"committed ledger batch no longer matches speaker_names for {paragraph_id}"
            )
        if (
            not allow_speaker_replacement
            and current_speakers is not None
            and list(current_speakers) != desired_speakers
        ):
            raise BackfillError(
                f"existing speaker_names drift detected for paragraph {paragraph_id}; "
                "refusing to overwrite a non-NULL attribution"
            )
        observed_ids.add(paragraph_id)
    if observed_ids != set(expected):
        raise BackfillError("database batch is missing frozen paragraph ids")


def _apply_batch(
    connection: Any,
    batch_index: int,
    records: Sequence[dict[str, object]],
) -> tuple[int, int]:
    transcript_ids = list(dict.fromkeys(str(record["transcriptId"]) for record in records))
    with connection.transaction():
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '3s'")
            cursor.execute("SET LOCAL statement_timeout = '30s'")
            cursor.execute("SET LOCAL idle_in_transaction_session_timeout = '30s'")
            cursor.execute(
                """
                SELECT
                  id::text,
                  transcript_id::text,
                  paragraph_number,
                  body_text,
                  speaker_names
                FROM public.transcript_paragraphs
                WHERE transcript_id = ANY(%s::uuid[])
                ORDER BY transcript_id, paragraph_number, id
                FOR UPDATE
                """,
                (transcript_ids,),
            )
            database_rows = cursor.fetchall()
            _verify_batch_rows(database_rows, records)
            desired_payload = json.dumps(
                [
                    {"id": record["id"], "speaker_names": record["speakerNames"]}
                    for record in records
                ],
                ensure_ascii=False,
                separators=(",", ":"),
            )
            cursor.execute(
                """
                WITH desired AS (
                  SELECT item.id, item.speaker_names
                  FROM pg_catalog.jsonb_to_recordset(%s::jsonb)
                    AS item(id uuid, speaker_names text[])
                )
                UPDATE public.transcript_paragraphs AS paragraph
                SET speaker_names = desired.speaker_names
                FROM desired
                WHERE paragraph.id = desired.id
                  AND paragraph.speaker_names IS DISTINCT FROM desired.speaker_names
                RETURNING paragraph.id::text
                """,
                (desired_payload,),
            )
            updated_ids = {str(row[0]) for row in cursor.fetchall()}
            if not updated_ids.issubset({str(record["id"]) for record in records}):
                raise BackfillError(f"batch {batch_index} updated an unexpected paragraph")
            cursor.execute(
                """
                SELECT id::text, speaker_names
                FROM public.transcript_paragraphs
                WHERE transcript_id = ANY(%s::uuid[])
                ORDER BY transcript_id, paragraph_number, id
                """,
                (transcript_ids,),
            )
            after = cursor.fetchall()
            expected_speakers = {
                str(record["id"]): list(record["speakerNames"]) for record in records
            }
            if len(after) != len(records):
                raise BackfillError("post-update batch row count changed")
            for paragraph_id, speaker_names in after:
                if speaker_names != expected_speakers.get(str(paragraph_id)):
                    raise BackfillError(
                        f"speaker_names verification failed for paragraph {paragraph_id}"
                    )
    return len(updated_ids), len(records) - len(updated_ids)


def _verify_completed_batch(
    connection: Any,
    records: Sequence[dict[str, object]],
) -> None:
    transcript_ids = list(dict.fromkeys(str(record["transcriptId"]) for record in records))
    with connection.transaction():
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '3s'")
            cursor.execute("SET LOCAL statement_timeout = '30s'")
            cursor.execute("SET LOCAL idle_in_transaction_session_timeout = '30s'")
            cursor.execute(
                """
                SELECT
                  id::text,
                  transcript_id::text,
                  paragraph_number,
                  body_text,
                  speaker_names
                FROM public.transcript_paragraphs
                WHERE transcript_id = ANY(%s::uuid[])
                ORDER BY transcript_id, paragraph_number, id
                FOR SHARE
                """,
                (transcript_ids,),
            )
            _verify_batch_rows(
                cursor.fetchall(),
                records,
                require_desired_speakers=True,
            )


def _verify_entire_corpus(
    connection: Any,
    records: Sequence[dict[str, object]],
    *,
    fetch_size: int = 1_000,
) -> None:
    """Recheck every frozen identity, body, and final array under row locks."""

    with connection.transaction():
        with connection.cursor() as control:
            control.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            control.execute("SET LOCAL lock_timeout = '3s'")
            control.execute("SET LOCAL statement_timeout = '120s'")
            control.execute("SET LOCAL idle_in_transaction_session_timeout = '150s'")
        with connection.cursor(name="transcript_speaker_final_verify") as cursor:
            cursor.execute(
                """
                SELECT
                  id::text,
                  transcript_id::text,
                  paragraph_number,
                  body_text,
                  speaker_names
                FROM public.transcript_paragraphs
                ORDER BY transcript_id, paragraph_number, id
                FOR SHARE
                """
            )
            offset = 0
            while True:
                database_rows = cursor.fetchmany(fetch_size)
                if not database_rows:
                    break
                frozen_rows = records[offset : offset + len(database_rows)]
                if len(frozen_rows) != len(database_rows):
                    raise BackfillError("database gained rows during final corpus verification")
                _verify_batch_rows(
                    database_rows,
                    frozen_rows,
                    require_desired_speakers=True,
                )
                offset += len(database_rows)
            if offset != len(records):
                raise BackfillError("database lost rows during final corpus verification")


def run_apply(args: argparse.Namespace) -> int:
    if not args.execute_approved_backfill:
        raise BackfillError("apply requires --execute-approved-backfill")
    _verify_runtime_dependencies(require_psycopg=True)
    artifact_dir = args.artifact_dir.resolve()
    manifest, manifest_sha, records = _verify_frozen_packet(artifact_dir)
    expected_marker = f"{APPROVAL_PREFIX}{manifest_sha}"
    if os.environ.get(APPROVAL_ENV) != expected_marker:
        raise BackfillError(
            f"{APPROVAL_ENV} must exactly equal the hash-bound approval marker"
        )
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise BackfillError("DATABASE_URL is required for apply")
    source = manifest.get("source")
    if not isinstance(source, dict) or not isinstance(source.get("projectRef"), str):
        raise BackfillError("approved manifest source project ref is invalid")
    project_ref = str(source["projectRef"])
    if project_ref == "local-test":
        raise BackfillError("a local-test dry-run manifest cannot authorize a database apply")
    _validate_database_target(database_url, project_ref)
    batches = list(_transcript_complete_batches(records, args.batch_size))
    completed_batches = _load_existing_ledger(
        artifact_dir / LEDGER_FILE,
        manifest_sha,
        batches,
    )

    try:
        import psycopg
    except ImportError as exc:
        raise BackfillError("apply requires psycopg 3") from exc

    lock_key = _advisory_lock_key(project_ref)
    connection = None
    lock_acquired = False
    total_updated = 0
    total_unchanged = 0
    try:
        try:
            connection = psycopg.connect(
                database_url,
                autocommit=True,
                connect_timeout=10,
                application_name="transcript-speaker-backfill",
            )
        except Exception as exc:
            raise BackfillError(f"database connection failed: {type(exc).__name__}") from exc
        with connection.cursor() as cursor:
            cursor.execute("SET lock_timeout = '3s'")
            cursor.execute("SET statement_timeout = '30s'")
            cursor.execute("SET idle_in_transaction_session_timeout = '30s'")
            cursor.execute("SELECT pg_catalog.pg_try_advisory_lock(%s)", (lock_key,))
            lock_acquired = bool(cursor.fetchone()[0])
            if not lock_acquired:
                raise BackfillError("another transcript speaker backfill holds the advisory lock")
            _schema_preflight(cursor)
            before_counts = _database_counts(cursor)
        approved_paragraphs = int(manifest["corpusInput"]["paragraphs"])  # type: ignore[index]
        approved_transcripts = int(manifest["corpusInput"]["transcripts"])  # type: ignore[index]
        if before_counts[0] != approved_paragraphs:
            raise BackfillError("database paragraph count drifted from the approved dry-run")
        if before_counts[1] != approved_transcripts or before_counts[2] != 0:
            raise BackfillError("database transcript identity counts drifted from the dry-run")
        with connection.cursor() as cursor:
            checked_existing = _existing_speaker_values_preflight(cursor, records)
        if checked_existing != before_counts[3]:
            raise BackfillError("existing speaker_names count changed during apply preflight")

        for batch_index, batch in batches:
            if batch_index in completed_batches:
                _verify_completed_batch(connection, batch)
                total_unchanged += len(batch)
                print(
                    f"apply reverified: batch={batch_index + 1}/{len(batches)} "
                    f"rows={len(batch)} ledger=committed",
                    flush=True,
                )
                continue
            updated, unchanged = _apply_batch(connection, batch_index, batch)
            total_updated += updated
            total_unchanged += unchanged
            transcript_ids = list(
                dict.fromkeys(str(record["transcriptId"]) for record in batch)
            )
            _append_ledger(
                artifact_dir / LEDGER_FILE,
                {
                    "batchIndex": batch_index,
                    "batchSha256": _batch_sha(batch),
                    "committedAt": datetime.now(timezone.utc)
                    .isoformat(timespec="seconds")
                    .replace("+00:00", "Z"),
                    "firstParagraphId": batch[0]["id"],
                    "lastParagraphId": batch[-1]["id"],
                    "manifestSha256": manifest_sha,
                    "paragraphs": len(batch),
                    "transcripts": len(transcript_ids),
                    "unchangedRows": unchanged,
                    "updatedRows": updated,
                },
            )
            print(
                f"apply committed: batch={batch_index + 1}/{len(batches)} "
                f"rows={len(batch)} updated={updated} unchanged={unchanged}",
                flush=True,
            )

        _verify_entire_corpus(connection, records)
        with connection.cursor() as cursor:
            after_counts = _database_counts(cursor)
        if after_counts[0] != approved_paragraphs or after_counts[1] != approved_transcripts:
            raise BackfillError("database corpus counts changed during apply")
        if after_counts[2] != 0 or after_counts[3] != approved_paragraphs:
            raise BackfillError("final speaker_names coverage verification failed")
    except BackfillError:
        raise
    except psycopg.Error as exc:
        sqlstate = getattr(exc, "sqlstate", None)
        suffix = f" SQLSTATE={sqlstate}" if sqlstate else ""
        raise BackfillError(
            f"database operation failed: {type(exc).__name__}{suffix}"
        ) from exc
    finally:
        if connection is not None:
            if lock_acquired:
                with suppress(Exception):
                    with connection.cursor() as cursor:
                        cursor.execute("SELECT pg_catalog.pg_advisory_unlock(%s)", (lock_key,))
            with suppress(Exception):
                connection.close()
    print(
        f"apply complete: rows={len(records)} updated={total_updated} "
        f"unchanged={total_unchanged}"
    )
    return 0


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Freeze and apply deterministic transcript speaker mappings."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    dry_run = subparsers.add_parser(
        "dry-run", help="read the complete corpus and write local evidence only"
    )
    dry_run.add_argument(
        "--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIR
    )
    dry_run.add_argument(
        "--page-size", type=_positive_int, default=DEFAULT_PAGE_SIZE
    )
    dry_run.add_argument(
        "--timeout-seconds", type=float, default=60.0
    )
    dry_run.set_defaults(handler=run_dry_run)

    apply = subparsers.add_parser(
        "apply", help="apply an explicitly approved frozen mapping packet"
    )
    apply.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIR)
    apply.add_argument("--batch-size", type=_positive_int, default=DEFAULT_BATCH_SIZE)
    apply.add_argument(
        "--execute-approved-backfill",
        action="store_true",
        help="required in addition to the exact hash-bound approval marker",
    )
    apply.set_defaults(handler=run_apply)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "dry-run":
        if args.page_size > MAX_PAGE_SIZE:
            parser.error(f"--page-size must be at most {MAX_PAGE_SIZE}")
        if not (0 < args.timeout_seconds <= 300):
            parser.error("--timeout-seconds must be greater than 0 and at most 300")
    if args.command == "apply" and args.batch_size > MAX_BATCH_SIZE:
        parser.error(f"--batch-size must be at most {MAX_BATCH_SIZE}")
    try:
        return int(args.handler(args))
    except BackfillError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("ERROR: interrupted; the active database transaction was rolled back", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
