"""Approval-gated recomputation of one complete transcript's speakers.

``dry-run`` reads exactly one transcript through the public Supabase Data API,
maps it locally, and freezes both its current and desired ``speaker_names``
states without persisting ``body_text``. ``apply`` accepts only that exact,
hash-bound packet and updates the whole transcript in one transaction.

This operator is intentionally separate from the initial corpus backfill: a
later edit to an early paragraph can change inheritance for every following
paragraph, so partial transcript updates are never supported here.
"""

from __future__ import annotations

import argparse
from contextlib import suppress
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Iterable, Mapping, Sequence

import requests

import backfill
from mapper import canonical_json, map_corpus


FORMAT_VERSION = 1
MAX_TRANSCRIPT_ROWS = 500
APPROVAL_ENV = "TRANSCRIPT_SPEAKER_RECOMPUTE_APPROVAL"
APPROVAL_PREFIX = "I_APPROVE_TRANSCRIPT_SPEAKER_RECOMPUTE:"
DEFAULT_ARTIFACT_ROOT = Path("work/transcript-speaker-recompute")

SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[2]
REQUIREMENTS_PATH = SCRIPT_PATH.with_name("requirements.txt")

MAPPING_FILE = "recompute-mapping.ndjson"
VERIFICATION_FILE = "recompute-verification.json"
MANIFEST_FILE = "recompute-manifest.json"
MANIFEST_SHA_FILE = "recompute-manifest.sha256"
RESULT_FILE = "recompute-result.json"

_SOURCE_FIELDS = {
    "id",
    "transcript_id",
    "paragraph_number",
    "body_text",
    "speaker_names",
}
_RECORD_FIELDS = {
    "id",
    "transcriptId",
    "paragraphNumber",
    "bodySha256",
    "currentSpeakerNames",
    "desiredSpeakerNames",
    "beforeSpeaker",
    "afterSpeaker",
    "evidenceModes",
    "suspiciousCodes",
}
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_CONTENT_RANGE_PATTERN = re.compile(r"^(?:\d+-\d+|\*)/(\d+)$")


RecomputeError = backfill.BackfillError


def _sha256_bytes(value: bytes) -> str:
    return sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    return backfill._sha256_file(path)


def _relative_repo_path(path: Path) -> str:
    return backfill._relative_repo_path(path)


def _canonical_uuid(value: object, field: str) -> str:
    return backfill._canonical_uuid(value, field)


def _validate_speaker_names(
    value: object,
    *,
    field: str,
    allow_null: bool,
) -> list[str] | None:
    if value is None:
        if allow_null:
            return None
        raise RecomputeError(f"{field} must be an array")
    if not isinstance(value, (list, tuple)):
        raise RecomputeError(f"{field} must be an array or NULL")
    normalized = list(value)
    if any(not isinstance(name, str) or not name for name in normalized):
        raise RecomputeError(f"{field} contains an invalid speaker name")
    folded = [name.casefold() for name in normalized]
    if len(folded) != len(set(folded)):
        raise RecomputeError(f"{field} contains duplicate speaker names")
    return normalized


def _filtered_exact_count(
    session: requests.Session,
    endpoint: str,
    transcript_id: str,
    timeout_seconds: float,
) -> int:
    try:
        response = session.head(
            endpoint,
            params={"select": "id", "transcript_id": f"eq.{transcript_id}"},
            headers={"Prefer": "count=exact", "Range": "0-0", "Range-Unit": "items"},
            timeout=(10, timeout_seconds),
        )
    except requests.RequestException as exc:
        raise RecomputeError(
            f"transcript exact-count request failed: {type(exc).__name__}"
        ) from exc
    if not 200 <= response.status_code < 300:
        raise backfill._safe_http_error(response, "transcript exact-count request")
    content_range = response.headers.get("content-range", "")
    match = _CONTENT_RANGE_PATTERN.fullmatch(content_range.strip())
    if match is None:
        raise RecomputeError(
            "Data API transcript count omitted a valid Content-Range total"
        )
    return int(match.group(1))


def _validate_source_row(raw: object, transcript_id: str) -> dict[str, object]:
    if not isinstance(raw, dict) or set(raw) != _SOURCE_FIELDS:
        raise RecomputeError(
            "Data API row shape changed; expected only id, transcript_id, "
            "paragraph_number, body_text, and speaker_names"
        )
    paragraph_id = _canonical_uuid(raw["id"], "id")
    observed_transcript_id = _canonical_uuid(
        raw["transcript_id"], f"row {paragraph_id} transcript_id"
    )
    if observed_transcript_id != transcript_id:
        raise RecomputeError("Data API transcript filter returned a different transcript")
    paragraph_number = raw["paragraph_number"]
    if (
        isinstance(paragraph_number, bool)
        or not isinstance(paragraph_number, int)
        or paragraph_number < 1
    ):
        raise RecomputeError(f"row {paragraph_id} has an invalid paragraph_number")
    body_text = raw["body_text"]
    if not isinstance(body_text, str):
        raise RecomputeError(f"row {paragraph_id} has non-string body_text")
    try:
        body_text.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise RecomputeError(
            f"row {paragraph_id} body_text is not valid UTF-8 text"
        ) from exc
    speaker_names = _validate_speaker_names(
        raw["speaker_names"],
        field=f"row {paragraph_id} speaker_names",
        allow_null=True,
    )
    return {
        "id": paragraph_id,
        "transcript_id": observed_transcript_id,
        "paragraph_number": paragraph_number,
        "body_text": body_text,
        "speaker_names": speaker_names,
    }


def _canonicalize_single_transcript(
    rows: Sequence[dict[str, object]], transcript_id: str
) -> tuple[list[dict[str, object]], str]:
    if not rows:
        raise RecomputeError(f"transcript {transcript_id} has no visible paragraphs")
    if len(rows) > MAX_TRANSCRIPT_ROWS:
        raise RecomputeError(
            f"transcript {transcript_id} exceeds the {MAX_TRANSCRIPT_ROWS}-row safety limit"
        )
    ordered = sorted(
        rows,
        key=lambda row: (int(row["paragraph_number"]), str(row["id"])),
    )
    ids: set[str] = set()
    digest = sha256()
    for expected_number, row in enumerate(ordered, start=1):
        paragraph_id = str(row["id"])
        if row["transcript_id"] != transcript_id:
            raise RecomputeError("frozen rows contain more than one transcript")
        if paragraph_id in ids:
            raise RecomputeError(f"duplicate paragraph id {paragraph_id}")
        ids.add(paragraph_id)
        if row["paragraph_number"] != expected_number:
            raise RecomputeError(
                f"transcript {transcript_id} is not complete and contiguous at "
                f"paragraph {row['paragraph_number']}"
            )
        digest.update(
            canonical_json(
                {
                    "body_text": row["body_text"],
                    "id": paragraph_id,
                    "paragraph_number": expected_number,
                    "speaker_names": row["speaker_names"],
                    "transcript_id": transcript_id,
                }
            ).encode("utf-8")
        )
        digest.update(b"\n")
    return ordered, digest.hexdigest()


def _fetch_transcript(
    session: requests.Session,
    endpoint: str,
    transcript_id: str,
    timeout_seconds: float,
) -> tuple[list[dict[str, object]], int, int]:
    count_before = _filtered_exact_count(
        session, endpoint, transcript_id, timeout_seconds
    )
    if count_before < 1:
        raise RecomputeError(f"transcript {transcript_id} has no visible paragraphs")
    if count_before > MAX_TRANSCRIPT_ROWS:
        raise RecomputeError(
            f"transcript {transcript_id} exceeds the {MAX_TRANSCRIPT_ROWS}-row safety limit"
        )
    params = {
        "select": "id,transcript_id,paragraph_number,body_text,speaker_names",
        "transcript_id": f"eq.{transcript_id}",
        "order": "paragraph_number.asc,id.asc",
        "limit": str(MAX_TRANSCRIPT_ROWS + 1),
    }
    try:
        response = session.get(
            endpoint,
            params=params,
            timeout=(10, timeout_seconds),
        )
    except requests.RequestException as exc:
        raise RecomputeError(
            f"transcript Data API request failed: {type(exc).__name__}"
        ) from exc
    if not 200 <= response.status_code < 300:
        raise backfill._safe_http_error(response, "transcript Data API request")
    try:
        payload = response.json()
    except (ValueError, requests.JSONDecodeError) as exc:
        raise RecomputeError("transcript Data API response was not valid JSON") from exc
    if not isinstance(payload, list):
        raise RecomputeError("transcript Data API response was not a JSON array")
    if len(payload) > MAX_TRANSCRIPT_ROWS:
        raise RecomputeError(
            f"transcript {transcript_id} exceeds the {MAX_TRANSCRIPT_ROWS}-row safety limit"
        )
    rows = [_validate_source_row(raw, transcript_id) for raw in payload]
    count_after = _filtered_exact_count(
        session, endpoint, transcript_id, timeout_seconds
    )
    if count_before != count_after or count_after != len(rows):
        raise RecomputeError(
            "transcript row count changed during the read-only scan or did not match fetched rows"
        )
    return rows, count_before, count_after


def _code_paths() -> tuple[Path, ...]:
    return (
        SCRIPT_PATH,
        backfill.SCRIPT_PATH,
        backfill.MAPPER_PATH,
        backfill.MIGRATION_PATH,
        backfill.ROLLBACK_PATH,
        REQUIREMENTS_PATH,
    )


def _code_hash_records() -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for path in _code_paths():
        if not path.is_file():
            raise RecomputeError(
                f"required recompute code file is missing: {_relative_repo_path(path)}"
            )
        records.append(
            {"path": _relative_repo_path(path), "sha256": _sha256_file(path)}
        )
    return records


def _state_hash(records: Sequence[Mapping[str, object]], field: str) -> str:
    payload = [
        {"id": record["id"], "speakerNames": record[field]} for record in records
    ]
    return _sha256_bytes((canonical_json(payload) + "\n").encode("utf-8"))


def _identity_body_hash(records: Sequence[Mapping[str, object]]) -> str:
    payload = [
        {
            "bodySha256": record["bodySha256"],
            "id": record["id"],
            "paragraphNumber": record["paragraphNumber"],
            "transcriptId": record["transcriptId"],
        }
        for record in records
    ]
    return _sha256_bytes((canonical_json(payload) + "\n").encode("utf-8"))


def _mapping_records(
    rows: Sequence[dict[str, object]], transcript_id: str
) -> tuple[list[dict[str, object]], Mapping[str, int]]:
    mapped, stats = map_corpus(rows)
    base_records = [backfill._validate_mapping_record(item.to_record()) for item in mapped]
    by_id = {str(row["id"]): row for row in rows}
    records: list[dict[str, object]] = []
    for base in base_records:
        paragraph_id = str(base["id"])
        row = by_id.get(paragraph_id)
        if row is None:
            raise RecomputeError("mapper returned a paragraph absent from the transcript")
        if base["transcriptId"] != transcript_id:
            raise RecomputeError("mapper changed the requested transcript identity")
        records.append(
            {
                "id": paragraph_id,
                "transcriptId": transcript_id,
                "paragraphNumber": base["paragraphNumber"],
                "bodySha256": base["bodySha256"],
                "currentSpeakerNames": row["speaker_names"],
                "desiredSpeakerNames": base["speakerNames"],
                "beforeSpeaker": base["beforeSpeaker"],
                "afterSpeaker": base["afterSpeaker"],
                "evidenceModes": base["evidenceModes"],
                "suspiciousCodes": base["suspiciousCodes"],
            }
        )
    records.sort(key=lambda record: (int(record["paragraphNumber"]), str(record["id"])))
    if len(records) != len(rows):
        raise RecomputeError("mapper output count does not equal transcript row count")
    return records, stats.to_record()


def _write_ndjson(
    path: Path, records: Iterable[Mapping[str, object]]
) -> dict[str, object]:
    return backfill._write_ndjson(path, records)


def _write_json(path: Path, value: object) -> dict[str, object]:
    return backfill._write_canonical_json(path, value)


def _build_artifacts(
    rows: Sequence[dict[str, object]],
    transcript_id: str,
    artifact_dir: Path,
    source: Mapping[str, object],
) -> str:
    canonical_rows, source_snapshot_sha = _canonicalize_single_transcript(
        rows, transcript_id
    )
    records, stats = _mapping_records(canonical_rows, transcript_id)
    if stats.get("processedParagraphs") != len(records):
        raise RecomputeError("mapper paragraph stats do not match recompute output")
    if stats.get("processedTranscripts") != 1:
        raise RecomputeError("mapper did not process exactly one transcript")

    artifact_dir = artifact_dir.resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    if (artifact_dir / RESULT_FILE).exists():
        raise RecomputeError(
            "refusing to replace a recompute packet with an apply result; use a new directory"
        )

    mapping_meta = _write_ndjson(artifact_dir / MAPPING_FILE, records)
    changed_rows = sum(
        record["currentSpeakerNames"] != record["desiredSpeakerNames"]
        for record in records
    )
    verification = {
        "formatVersion": FORMAT_VERSION,
        "invariants": {
            "bodyTextExcludedFromArtifacts": True,
            "completeContiguousTranscript": True,
            "maximumTranscriptRows": MAX_TRANSCRIPT_ROWS,
            "singleTranscript": True,
        },
        "mappingCounts": {
            **stats,
            "changedRows": changed_rows,
            "unchangedRows": len(records) - changed_rows,
        },
        "stateSnapshots": {
            "currentSpeakerNamesSha256": _state_hash(
                records, "currentSpeakerNames"
            ),
            "desiredSpeakerNamesSha256": _state_hash(
                records, "desiredSpeakerNames"
            ),
            "identityBodySha256": _identity_body_hash(records),
            "sourceSnapshotSha256": source_snapshot_sha,
        },
        "sourceScan": dict(source),
    }
    verification_meta = _write_json(
        artifact_dir / VERIFICATION_FILE, verification
    )
    manifest = {
        "formatVersion": FORMAT_VERSION,
        "purpose": "transcript-speaker-recompute",
        "source": dict(source),
        "transcriptInput": {
            "firstParagraphId": records[0]["id"],
            "lastParagraphId": records[-1]["id"],
            "paragraphs": len(records),
            "transcriptId": transcript_id,
        },
        "stateSnapshots": verification["stateSnapshots"],
        "expectedCounts": verification["mappingCounts"],
        "artifacts": {
            MAPPING_FILE: mapping_meta,
            VERIFICATION_FILE: verification_meta,
        },
        "codeFiles": _code_hash_records(),
        "approval": {
            "environmentVariable": APPROVAL_ENV,
            "markerPrefix": APPROVAL_PREFIX,
        },
        "writeContract": {
            "column": "public.transcript_paragraphs.speaker_names",
            "maximumRows": MAX_TRANSCRIPT_ROWS,
            "oneTransaction": True,
            "schemaChanges": False,
            "wholeTranscript": True,
        },
    }
    manifest_bytes = (canonical_json(manifest) + "\n").encode("utf-8")
    backfill._atomic_write_bytes(artifact_dir / MANIFEST_FILE, manifest_bytes)
    manifest_sha = _sha256_bytes(manifest_bytes)
    backfill._atomic_write_bytes(
        artifact_dir / MANIFEST_SHA_FILE,
        (manifest_sha + "\n").encode("ascii"),
    )
    return manifest_sha


def _artifact_dir(args: argparse.Namespace, transcript_id: str) -> Path:
    supplied = getattr(args, "artifact_dir", None)
    return (DEFAULT_ARTIFACT_ROOT / transcript_id) if supplied is None else supplied


def run_dry_run(args: argparse.Namespace) -> int:
    backfill._verify_runtime_dependencies(require_psycopg=False)
    transcript_id = _canonical_uuid(args.transcript_id, "--transcript-id")
    supabase_url = os.environ.get("SUPABASE_URL", "").strip()
    publishable_key = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip()
    if not supabase_url:
        raise RecomputeError("SUPABASE_URL is required for dry-run")
    if not publishable_key:
        raise RecomputeError("SUPABASE_PUBLISHABLE_KEY is required for dry-run")
    project_ref = backfill._project_ref_from_url(supabase_url)
    endpoint = backfill._rest_endpoint(supabase_url)
    with requests.Session() as session:
        session.headers.update(
            {
                "Accept": "application/json",
                "Authorization": f"Bearer {publishable_key}",
                "apikey": publishable_key,
                "User-Agent": "transcript-speaker-recompute/1",
            }
        )
        rows, count_before, count_after = _fetch_transcript(
            session, endpoint, transcript_id, args.timeout_seconds
        )
    canonical_rows, _ = _canonicalize_single_transcript(rows, transcript_id)
    source = {
        "access": "publishable-key-read-only-data-api",
        "countAfter": count_after,
        "countBefore": count_before,
        "firstParagraphId": canonical_rows[0]["id"],
        "lastParagraphId": canonical_rows[-1]["id"],
        "projectRef": project_ref,
        "table": f"public.{backfill.TABLE_NAME}",
        "transcriptId": transcript_id,
    }
    artifact_dir = _artifact_dir(args, transcript_id)
    manifest_sha = _build_artifacts(rows, transcript_id, artifact_dir, source)
    print(f"recompute dry-run complete: transcript={transcript_id} rows={len(rows)}")
    print(f"artifact directory: {artifact_dir.resolve()}")
    print(f"manifest SHA-256: {manifest_sha}")
    print(f"required recompute marker: {APPROVAL_PREFIX}{transcript_id}:{manifest_sha}")
    print("no database writes were performed")
    return 0


def _load_json(path: Path) -> object:
    return backfill._load_canonical_json(path)


def _load_manifest(artifact_dir: Path) -> tuple[dict[str, object], str]:
    manifest_path = artifact_dir / MANIFEST_FILE
    sha_path = artifact_dir / MANIFEST_SHA_FILE
    if not manifest_path.is_file() or not sha_path.is_file():
        raise RecomputeError("frozen recompute manifest and SHA-256 file are required")
    try:
        sha_text = sha_path.read_text(encoding="ascii")
    except (OSError, UnicodeDecodeError) as exc:
        raise RecomputeError("recompute-manifest.sha256 is not readable ASCII") from exc
    if not re.fullmatch(r"[0-9a-f]{64}\n", sha_text):
        raise RecomputeError("recompute-manifest.sha256 has an invalid format")
    expected_sha = sha_text.strip()
    if _sha256_file(manifest_path) != expected_sha:
        raise RecomputeError("recompute manifest hash does not match its SHA-256 file")
    loaded = _load_json(manifest_path)
    if not isinstance(loaded, dict):
        raise RecomputeError("recompute manifest root must be an object")
    if loaded.get("formatVersion") != FORMAT_VERSION:
        raise RecomputeError("unsupported recompute manifest formatVersion")
    if loaded.get("purpose") != "transcript-speaker-recompute":
        raise RecomputeError("manifest purpose is not transcript-speaker-recompute")
    return loaded, expected_sha


def _artifact_metadata(
    manifest: Mapping[str, object], filename: str
) -> Mapping[str, object]:
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict) or set(artifacts) != {
        MAPPING_FILE,
        VERIFICATION_FILE,
    }:
        raise RecomputeError("recompute manifest artifact set is invalid")
    metadata = artifacts.get(filename)
    if not isinstance(metadata, dict):
        raise RecomputeError(f"recompute metadata for {filename} is invalid")
    return metadata


def _validate_record(raw: object) -> dict[str, object]:
    if not isinstance(raw, dict) or set(raw) != _RECORD_FIELDS:
        raise RecomputeError("recompute mapping record shape changed")
    compatibility_record = {
        "id": raw["id"],
        "transcriptId": raw["transcriptId"],
        "paragraphNumber": raw["paragraphNumber"],
        "bodySha256": raw["bodySha256"],
        "speakerNames": raw["desiredSpeakerNames"],
        "beforeSpeaker": raw["beforeSpeaker"],
        "afterSpeaker": raw["afterSpeaker"],
        "evidenceModes": raw["evidenceModes"],
        "suspiciousCodes": raw["suspiciousCodes"],
    }
    validated = backfill._validate_mapping_record(compatibility_record)
    current = _validate_speaker_names(
        raw["currentSpeakerNames"],
        field=f"mapping {validated['id']} currentSpeakerNames",
        allow_null=True,
    )
    return {
        "id": validated["id"],
        "transcriptId": validated["transcriptId"],
        "paragraphNumber": validated["paragraphNumber"],
        "bodySha256": validated["bodySha256"],
        "currentSpeakerNames": current,
        "desiredSpeakerNames": validated["speakerNames"],
        "beforeSpeaker": validated["beforeSpeaker"],
        "afterSpeaker": validated["afterSpeaker"],
        "evidenceModes": validated["evidenceModes"],
        "suspiciousCodes": validated["suspiciousCodes"],
    }


def _load_records(path: Path) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.endswith("\n"):
                    raise RecomputeError(
                        f"{path.name} line {line_number} lacks a newline"
                    )
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise RecomputeError(
                        f"{path.name} line {line_number} is invalid JSON"
                    ) from exc
                if line != canonical_json(raw) + "\n":
                    raise RecomputeError(
                        f"{path.name} line {line_number} is not canonical JSON"
                    )
                records.append(_validate_record(raw))
    except (OSError, UnicodeDecodeError) as exc:
        raise RecomputeError(f"could not read {path.name}: {type(exc).__name__}") from exc
    if not records:
        raise RecomputeError("recompute mapping artifact is empty")
    if len(records) > MAX_TRANSCRIPT_ROWS:
        raise RecomputeError("recompute mapping exceeds the transcript row limit")
    transcript_ids = {str(record["transcriptId"]) for record in records}
    if len(transcript_ids) != 1:
        raise RecomputeError("recompute mapping does not contain exactly one transcript")
    ordered = sorted(
        records,
        key=lambda record: (int(record["paragraphNumber"]), str(record["id"])),
    )
    if records != ordered:
        raise RecomputeError("recompute mapping is not canonically ordered")
    ids: set[str] = set()
    for expected_number, record in enumerate(records, start=1):
        if record["id"] in ids:
            raise RecomputeError("recompute mapping contains duplicate paragraph ids")
        ids.add(str(record["id"]))
        if record["paragraphNumber"] != expected_number:
            raise RecomputeError("recompute mapping is not complete and contiguous")
    return records


def _verify_code_hashes(manifest: Mapping[str, object]) -> None:
    code_files = manifest.get("codeFiles")
    if not isinstance(code_files, list) or not code_files:
        raise RecomputeError("recompute manifest codeFiles are invalid")
    expected_paths = {_relative_repo_path(path) for path in _code_paths()}
    observed_paths: set[str] = set()
    for item in code_files:
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            raise RecomputeError("recompute code file record is invalid")
        relative = item["path"]
        expected_sha = item["sha256"]
        if not isinstance(relative, str) or relative not in expected_paths:
            raise RecomputeError("recompute manifest contains an unexpected code path")
        if not isinstance(expected_sha, str) or not _SHA256_PATTERN.fullmatch(expected_sha):
            raise RecomputeError(f"invalid approved code hash for {relative}")
        path = (REPO_ROOT / relative).resolve()
        try:
            path.relative_to(REPO_ROOT)
        except ValueError as exc:
            raise RecomputeError("recompute code path escaped the repository") from exc
        if not path.is_file() or _sha256_file(path) != expected_sha:
            raise RecomputeError(f"approved code hash changed: {relative}")
        if relative in observed_paths:
            raise RecomputeError("recompute manifest repeats a code file")
        observed_paths.add(relative)
    if observed_paths != expected_paths:
        raise RecomputeError("recompute manifest code file set is incomplete")


def _verify_frozen_packet(
    artifact_dir: Path,
) -> tuple[dict[str, object], str, list[dict[str, object]]]:
    manifest, manifest_sha = _load_manifest(artifact_dir)
    for filename in (MAPPING_FILE, VERIFICATION_FILE):
        backfill._verify_file_meta(
            artifact_dir / filename,
            _artifact_metadata(manifest, filename),
        )
    _verify_code_hashes(manifest)
    records = _load_records(artifact_dir / MAPPING_FILE)
    transcript_id = str(records[0]["transcriptId"])
    transcript_input = manifest.get("transcriptInput")
    if not isinstance(transcript_input, dict) or transcript_input != {
        "firstParagraphId": records[0]["id"],
        "lastParagraphId": records[-1]["id"],
        "paragraphs": len(records),
        "transcriptId": transcript_id,
    }:
        raise RecomputeError("manifest transcriptInput differs from the frozen mapping")
    source = manifest.get("source")
    if (
        not isinstance(source, dict)
        or set(source)
        != {
            "access",
            "countAfter",
            "countBefore",
            "firstParagraphId",
            "lastParagraphId",
            "projectRef",
            "table",
            "transcriptId",
        }
        or source.get("transcriptId") != transcript_id
        or source.get("table") != f"public.{backfill.TABLE_NAME}"
        or not isinstance(source.get("access"), str)
        or not source.get("access")
        or not isinstance(source.get("projectRef"), str)
        or source.get("countBefore") != len(records)
        or source.get("countAfter") != len(records)
        or source.get("firstParagraphId") != records[0]["id"]
        or source.get("lastParagraphId") != records[-1]["id"]
    ):
        raise RecomputeError("manifest source does not prove the frozen transcript scan")
    project_ref = str(source["projectRef"])
    if project_ref != "local-test" and re.fullmatch(r"[a-z0-9]{20}", project_ref) is None:
        raise RecomputeError("manifest source project ref is invalid")
    expected_snapshots = {
        "currentSpeakerNamesSha256": _state_hash(records, "currentSpeakerNames"),
        "desiredSpeakerNamesSha256": _state_hash(records, "desiredSpeakerNames"),
        "identityBodySha256": _identity_body_hash(records),
    }
    snapshots = manifest.get("stateSnapshots")
    if not isinstance(snapshots, dict) or set(snapshots) != {
        "currentSpeakerNamesSha256",
        "desiredSpeakerNamesSha256",
        "identityBodySha256",
        "sourceSnapshotSha256",
    }:
        raise RecomputeError("manifest stateSnapshots are invalid")
    for name, expected in expected_snapshots.items():
        if snapshots.get(name) != expected:
            raise RecomputeError(f"manifest {name} differs from the frozen mapping")
    source_snapshot = snapshots.get("sourceSnapshotSha256")
    if not isinstance(source_snapshot, str) or not _SHA256_PATTERN.fullmatch(source_snapshot):
        raise RecomputeError("manifest sourceSnapshotSha256 is invalid")
    verification = _load_json(artifact_dir / VERIFICATION_FILE)
    if not isinstance(verification, dict):
        raise RecomputeError("recompute verification root must be an object")
    invariants = verification.get("invariants")
    if invariants != {
        "bodyTextExcludedFromArtifacts": True,
        "completeContiguousTranscript": True,
        "maximumTranscriptRows": MAX_TRANSCRIPT_ROWS,
        "singleTranscript": True,
    }:
        raise RecomputeError("recompute verification invariants are invalid")
    if verification.get("stateSnapshots") != snapshots:
        raise RecomputeError("manifest and verification state snapshots differ")
    if verification.get("sourceScan") != source:
        raise RecomputeError("manifest and verification source scans differ")
    counts = verification.get("mappingCounts")
    if not isinstance(counts, dict) or counts.get("processedParagraphs") != len(records):
        raise RecomputeError("recompute verification paragraph count is invalid")
    if counts.get("processedTranscripts") != 1:
        raise RecomputeError("recompute verification transcript count is invalid")
    changed_rows = sum(
        record["currentSpeakerNames"] != record["desiredSpeakerNames"]
        for record in records
    )
    if counts.get("changedRows") != changed_rows:
        raise RecomputeError("recompute verification changed-row count is invalid")
    if counts.get("unchangedRows") != len(records) - changed_rows:
        raise RecomputeError("recompute verification unchanged-row count is invalid")
    if manifest.get("expectedCounts") != counts:
        raise RecomputeError("manifest and verification expected counts differ")
    if manifest.get("approval") != {
        "environmentVariable": APPROVAL_ENV,
        "markerPrefix": APPROVAL_PREFIX,
    }:
        raise RecomputeError("manifest approval contract is invalid")
    if manifest.get("writeContract") != {
        "column": "public.transcript_paragraphs.speaker_names",
        "maximumRows": MAX_TRANSCRIPT_ROWS,
        "oneTransaction": True,
        "schemaChanges": False,
        "wholeTranscript": True,
    }:
        raise RecomputeError("manifest write contract is invalid")
    return manifest, manifest_sha, records


def _normalize_database_speakers(value: object, paragraph_id: str) -> list[str] | None:
    return _validate_speaker_names(
        value,
        field=f"database paragraph {paragraph_id} speaker_names",
        allow_null=True,
    )


def _validate_locked_rows(
    database_rows: Sequence[Sequence[object]],
    records: Sequence[Mapping[str, object]],
) -> list[list[str] | None]:
    if len(database_rows) != len(records):
        raise RecomputeError("database transcript membership differs from the frozen packet")
    observed_states: list[list[str] | None] = []
    for index, (row, record) in enumerate(zip(database_rows, records)):
        if len(row) != 5:
            raise RecomputeError("database transcript query shape changed")
        paragraph_id = _canonical_uuid(row[0], "database paragraph id")
        transcript_id = _canonical_uuid(
            row[1], f"database paragraph {paragraph_id} transcript_id"
        )
        paragraph_number = row[2]
        body_text = row[3]
        if paragraph_id != record["id"]:
            raise RecomputeError(
                f"database transcript membership/order drifted at position {index + 1}"
            )
        if transcript_id != record["transcriptId"]:
            raise RecomputeError(f"transcript_id drift detected for paragraph {paragraph_id}")
        if paragraph_number != record["paragraphNumber"]:
            raise RecomputeError(
                f"paragraph_number drift detected for paragraph {paragraph_id}"
            )
        if not isinstance(body_text, str):
            raise RecomputeError(f"database paragraph {paragraph_id} has non-text body_text")
        if _sha256_bytes(body_text.encode("utf-8")) != record["bodySha256"]:
            raise RecomputeError(f"body_text drift detected for paragraph {paragraph_id}")
        observed_states.append(_normalize_database_speakers(row[4], paragraph_id))
    return observed_states


def _classify_state(
    observed: Sequence[list[str] | None],
    records: Sequence[Mapping[str, object]],
) -> str:
    current = [record["currentSpeakerNames"] for record in records]
    desired = [record["desiredSpeakerNames"] for record in records]
    if list(observed) == desired:
        return "already-desired"
    if list(observed) == current:
        return "frozen-current"
    if all(
        value == current[index] or value == desired[index]
        for index, value in enumerate(observed)
    ):
        raise RecomputeError(
            "database transcript is a mixed before/desired state; refusing partial recompute"
        )
    raise RecomputeError(
        "database transcript speaker_names are neither the frozen current state "
        "nor the desired state"
    )


def _select_transcript_for_lock(cursor: Any, transcript_id: str) -> list[Sequence[object]]:
    cursor.execute(
        """
        SELECT
          id::text,
          transcript_id::text,
          paragraph_number,
          body_text,
          speaker_names
        FROM public.transcript_paragraphs
        WHERE transcript_id = %s::uuid
        ORDER BY paragraph_number, id
        FOR UPDATE
        """,
        (transcript_id,),
    )
    return list(cursor.fetchall())


def _select_transcript_for_verify(cursor: Any, transcript_id: str) -> list[Sequence[object]]:
    cursor.execute(
        """
        SELECT
          id::text,
          transcript_id::text,
          paragraph_number,
          body_text,
          speaker_names
        FROM public.transcript_paragraphs
        WHERE transcript_id = %s::uuid
        ORDER BY paragraph_number, id
        """,
        (transcript_id,),
    )
    return list(cursor.fetchall())


def _apply_locked_recompute(
    connection: Any,
    transcript_id: str,
    records: Sequence[dict[str, object]],
) -> tuple[str, int, int]:
    with connection.transaction():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            cursor.execute("SET LOCAL lock_timeout = '3s'")
            cursor.execute("SET LOCAL statement_timeout = '30s'")
            cursor.execute("SET LOCAL idle_in_transaction_session_timeout = '30s'")
            database_rows = _select_transcript_for_lock(cursor, transcript_id)
            observed = _validate_locked_rows(database_rows, records)
            state_mode = _classify_state(observed, records)
            expected_changed_ids = {
                str(record["id"])
                for record in records
                if record["currentSpeakerNames"] != record["desiredSpeakerNames"]
            }
            updated_ids: set[str] = set()
            if state_mode == "frozen-current" and expected_changed_ids:
                desired_payload = json.dumps(
                    [
                        {
                            "id": record["id"],
                            "speaker_names": record["desiredSpeakerNames"],
                        }
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
                      AND paragraph.transcript_id = %s::uuid
                      AND paragraph.speaker_names IS DISTINCT FROM desired.speaker_names
                    RETURNING paragraph.id::text
                    """,
                    (desired_payload, transcript_id),
                )
                updated_ids = {str(row[0]) for row in cursor.fetchall()}
                if updated_ids != expected_changed_ids:
                    raise RecomputeError(
                        "recompute update set differed from the frozen desired changes"
                    )
            after_rows = _select_transcript_for_verify(cursor, transcript_id)
            after_states = _validate_locked_rows(after_rows, records)
            desired_states = [record["desiredSpeakerNames"] for record in records]
            if after_states != desired_states:
                raise RecomputeError("post-update transcript does not match the desired state")
    return state_mode, len(updated_ids), len(records) - len(updated_ids)


def _write_result(
    artifact_dir: Path,
    *,
    manifest_sha: str,
    transcript_id: str,
    records: Sequence[Mapping[str, object]],
    state_mode: str,
    updated_rows: int,
    unchanged_rows: int,
) -> None:
    result = {
        "completedAt": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "formatVersion": FORMAT_VERSION,
        "manifestSha256": manifest_sha,
        "paragraphs": len(records),
        "result": "committed" if state_mode == "frozen-current" else "idempotent",
        "stateAtLock": state_mode,
        "transcriptId": transcript_id,
        "unchangedRows": unchanged_rows,
        "updatedRows": updated_rows,
    }
    try:
        _write_json(artifact_dir / RESULT_FILE, result)
    except (OSError, RecomputeError) as exc:
        raise RecomputeError(
            "recompute transaction committed but result artifact could not be written; "
            "rerun with the same packet is safe"
        ) from exc


def run_apply(args: argparse.Namespace) -> int:
    if not args.execute_approved_recompute:
        raise RecomputeError("apply requires --execute-approved-recompute")
    backfill._verify_runtime_dependencies(require_psycopg=True)
    artifact_dir = _artifact_dir(args, "unused").resolve()
    manifest, manifest_sha, records = _verify_frozen_packet(artifact_dir)
    transcript_id = str(records[0]["transcriptId"])
    supplied_transcript_id = _canonical_uuid(args.transcript_id, "--transcript-id")
    if supplied_transcript_id != transcript_id:
        raise RecomputeError("--transcript-id does not match the frozen recompute packet")
    expected_marker = f"{APPROVAL_PREFIX}{transcript_id}:{manifest_sha}"
    if os.environ.get(APPROVAL_ENV) != expected_marker:
        raise RecomputeError(
            f"{APPROVAL_ENV} must exactly equal the transcript- and hash-bound approval marker"
        )
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise RecomputeError("DATABASE_URL is required for recompute apply")
    source = manifest.get("source")
    if not isinstance(source, dict) or not isinstance(source.get("projectRef"), str):
        raise RecomputeError("approved recompute source project ref is invalid")
    project_ref = str(source["projectRef"])
    if project_ref == "local-test":
        raise RecomputeError("a local-test recompute packet cannot authorize database apply")
    backfill._validate_database_target(database_url, project_ref)

    try:
        import psycopg
    except ImportError as exc:
        raise RecomputeError("recompute apply requires psycopg 3") from exc

    lock_key = backfill._advisory_lock_key(project_ref)
    connection = None
    lock_acquired = False
    try:
        try:
            connection = psycopg.connect(
                database_url,
                autocommit=True,
                connect_timeout=10,
                application_name="transcript-speaker-recompute",
            )
        except Exception as exc:
            raise RecomputeError(
                f"database connection failed: {type(exc).__name__}"
            ) from exc
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET lock_timeout = '3s'")
                cursor.execute("SET statement_timeout = '30s'")
                cursor.execute("SET idle_in_transaction_session_timeout = '30s'")
                cursor.execute("SELECT pg_catalog.pg_try_advisory_lock(%s)", (lock_key,))
                lock_acquired = bool(cursor.fetchone()[0])
                if not lock_acquired:
                    raise RecomputeError(
                        "another transcript speaker operation holds the project advisory lock"
                    )
                backfill._schema_preflight(cursor)
            state_mode, updated_rows, unchanged_rows = _apply_locked_recompute(
                connection, transcript_id, records
            )
        except RecomputeError:
            raise
        except psycopg.Error as exc:
            sqlstate = getattr(exc, "sqlstate", None)
            suffix = f" SQLSTATE={sqlstate}" if sqlstate else ""
            raise RecomputeError(
                f"database operation failed: {type(exc).__name__}{suffix}"
            ) from exc
        _write_result(
            artifact_dir,
            manifest_sha=manifest_sha,
            transcript_id=transcript_id,
            records=records,
            state_mode=state_mode,
            updated_rows=updated_rows,
            unchanged_rows=unchanged_rows,
        )
    finally:
        if connection is not None:
            if lock_acquired:
                with suppress(Exception):
                    with connection.cursor() as cursor:
                        cursor.execute(
                            "SELECT pg_catalog.pg_advisory_unlock(%s)", (lock_key,)
                        )
            with suppress(Exception):
                connection.close()
    print(
        f"recompute apply complete: transcript={transcript_id} rows={len(records)} "
        f"updated={updated_rows} unchanged={unchanged_rows} state={state_mode}"
    )
    return 0


def _positive_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a number") from exc
    if not (0 < parsed <= 300):
        raise argparse.ArgumentTypeError("must be greater than 0 and at most 300")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Freeze or apply one complete transcript speaker recomputation."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    dry_run = subparsers.add_parser(
        "dry-run", help="read and freeze exactly one transcript without writes"
    )
    dry_run.add_argument("--transcript-id", required=True)
    dry_run.add_argument("--artifact-dir", type=Path)
    dry_run.add_argument("--timeout-seconds", type=_positive_float, default=60.0)
    dry_run.set_defaults(handler=run_dry_run)

    apply = subparsers.add_parser(
        "apply", help="apply an explicitly approved complete-transcript packet"
    )
    apply.add_argument("--transcript-id", required=True)
    apply.add_argument("--artifact-dir", type=Path, required=True)
    apply.add_argument(
        "--execute-approved-recompute",
        action="store_true",
        help="required in addition to the exact transcript- and hash-bound marker",
    )
    apply.set_defaults(handler=run_apply)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except RecomputeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(
            "ERROR: interrupted; any active database transaction was rolled back",
            file=sys.stderr,
        )
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
