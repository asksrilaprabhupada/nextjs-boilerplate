from __future__ import annotations

import importlib.util
from hashlib import sha256
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location(
    "transcript_speaker_backfill", SCRIPT_DIR / "backfill.py"
)
assert SPEC is not None and SPEC.loader is not None
backfill = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backfill)


class _Response:
    status_code = 200
    headers: dict[str, str] = {}

    def __init__(self, payload: object):
        self._payload = payload

    def json(self) -> object:
        return self._payload


class _Session:
    def __init__(self, pages: list[list[dict[str, object]]]):
        self.pages = list(pages)
        self.params: list[dict[str, str]] = []

    def get(self, _endpoint: str, *, params: dict[str, str], timeout: object) -> _Response:
        del timeout
        self.params.append(dict(params))
        return _Response(self.pages.pop(0))


class BackfillRunnerTests(unittest.TestCase):
    def test_rest_scan_uses_uuid_keyset_and_never_offset(self) -> None:
        rows = [
            {
                "id": "00000000-0000-0000-0000-000000000001",
                "transcript_id": "10000000-0000-0000-0000-000000000001",
                "paragraph_number": 1,
                "body_text": "one",
            },
            {
                "id": "00000000-0000-0000-0000-000000000002",
                "transcript_id": "10000000-0000-0000-0000-000000000001",
                "paragraph_number": 2,
                "body_text": "two",
            },
            {
                "id": "00000000-0000-0000-0000-000000000003",
                "transcript_id": "10000000-0000-0000-0000-000000000002",
                "paragraph_number": 1,
                "body_text": "three",
            },
        ]
        session = _Session([rows[:2], rows[2:]])

        observed = backfill._fetch_rows(session, "https://example/rest", 2, 1.0)

        self.assertEqual(observed, rows)
        self.assertNotIn("id", session.params[0])
        self.assertEqual(session.params[1]["id"], f"gt.{rows[1]['id']}")
        self.assertTrue(all("offset" not in params for params in session.params))

    def test_complete_transcript_batches_never_split_a_transcript(self) -> None:
        records = []
        for transcript_suffix, row_count in ((1, 3), (2, 2), (3, 1)):
            transcript_id = f"10000000-0000-0000-0000-{transcript_suffix:012d}"
            for paragraph_number in range(1, row_count + 1):
                records.append(
                    {
                        "transcriptId": transcript_id,
                        "paragraphNumber": paragraph_number,
                        "id": f"20000000-0000-{transcript_suffix:04d}-0000-{paragraph_number:012d}",
                    }
                )

        batches = list(backfill._transcript_complete_batches(records, 4))

        self.assertEqual([len(batch) for _, batch in batches], [3, 3])
        locations: dict[str, set[int]] = {}
        for batch_index, batch in batches:
            for record in batch:
                locations.setdefault(record["transcriptId"], set()).add(batch_index)
        self.assertTrue(all(len(indices) == 1 for indices in locations.values()))

    def test_frozen_packet_has_hashes_and_never_persists_body_text(self) -> None:
        rows = [
            {
                "id": "7a59854c-12f8-47ff-a770-c576aff45fe1",
                "transcript_id": "10000000-0000-0000-0000-000000000001",
                "paragraph_number": 1,
                "body_text": "Prabhupāda: private fixture body one",
            },
            {
                "id": "c8de2aaf-6926-4bf9-b778-51ad1f6293d5",
                "transcript_id": "10000000-0000-0000-0000-000000000002",
                "paragraph_number": 1,
                "body_text": "Prabhupāda: private fixture body two\nDevotees: Jaya.",
            },
        ]
        source = {
            "access": "test-read-only",
            "countAfter": 2,
            "countBefore": 2,
            "firstId": rows[0]["id"],
            "lastId": rows[1]["id"],
            "projectRef": "local-test",
            "table": "public.transcript_paragraphs",
        }
        with tempfile.TemporaryDirectory() as temporary:
            artifact_dir = Path(temporary)
            manifest_sha = backfill._build_artifacts(rows, artifact_dir, source)

            manifest, loaded_sha, records = backfill._verify_frozen_packet(artifact_dir)

            self.assertEqual(loaded_sha, manifest_sha)
            self.assertEqual(len(records), 2)
            self.assertEqual(manifest["corpusInput"]["paragraphs"], 2)
            self.assertEqual(manifest["expectedCounts"]["knownSingleOnlyParagraphs"], 1)
            self.assertEqual(manifest["expectedCounts"]["knownMultipleOnlyParagraphs"], 1)
            self.assertEqual(manifest["expectedCounts"]["knownAndUnknownParagraphs"], 0)
            self.assertNotIn("knownMixedSpeakerParagraphs", manifest["expectedCounts"])
            mapping_bytes = (artifact_dir / backfill.MAPPING_FILE).read_bytes()
            self.assertNotIn(b"body_text", mapping_bytes)
            self.assertNotIn(b"private fixture body", mapping_bytes)

    def test_canonical_corpus_rejects_paragraph_gaps(self) -> None:
        rows = [
            {
                "id": "00000000-0000-0000-0000-000000000001",
                "transcript_id": "10000000-0000-0000-0000-000000000001",
                "paragraph_number": 2,
                "body_text": "gap",
            }
        ]
        with self.assertRaisesRegex(backfill.BackfillError, "starts at paragraph"):
            backfill._canonicalize_corpus(rows)

    def test_existing_non_null_speaker_drift_is_never_overwritten(self) -> None:
        body = "body"
        record = {
            "id": "00000000-0000-0000-0000-000000000001",
            "transcriptId": "10000000-0000-0000-0000-000000000001",
            "paragraphNumber": 1,
            "bodySha256": sha256(body.encode()).hexdigest(),
            "speakerNames": ["Devotees"],
        }
        database_row = (
            record["id"],
            record["transcriptId"],
            1,
            body,
            ["Guest"],
        )

        with self.assertRaisesRegex(backfill.BackfillError, "refusing to overwrite"):
            backfill._verify_batch_rows([database_row], [record])

        class Cursor:
            def execute(self, _query: str) -> None:
                return None

            def __iter__(self):
                return iter([(record["id"], ["Guest"])])

        with self.assertRaisesRegex(backfill.BackfillError, "no backfill rows"):
            backfill._existing_speaker_values_preflight(Cursor(), [record])

    def test_ledger_is_a_unique_hash_bound_batch_prefix(self) -> None:
        record = {
            "id": "00000000-0000-0000-0000-000000000001",
            "transcriptId": "10000000-0000-0000-0000-000000000001",
            "paragraphNumber": 1,
            "bodySha256": "0" * 64,
            "speakerNames": [],
        }
        batches = [(0, [record])]
        manifest_sha = "1" * 64
        ledger_record = {
            "batchIndex": 0,
            "batchSha256": backfill._batch_sha([record]),
            "committedAt": "2026-08-09T12:00:00Z",
            "firstParagraphId": record["id"],
            "lastParagraphId": record["id"],
            "manifestSha256": manifest_sha,
            "paragraphs": 1,
            "transcripts": 1,
            "unchangedRows": 0,
            "updatedRows": 1,
        }
        with tempfile.TemporaryDirectory() as temporary:
            ledger_path = Path(temporary) / backfill.LEDGER_FILE
            line = backfill.canonical_json(ledger_record) + "\n"
            ledger_path.write_text(line, encoding="utf-8", newline="")
            self.assertEqual(
                backfill._load_existing_ledger(ledger_path, manifest_sha, batches),
                {0},
            )
            ledger_path.write_text(line + line, encoding="utf-8", newline="")
            with self.assertRaisesRegex(backfill.BackfillError, "unique contiguous prefix"):
                backfill._load_existing_ledger(ledger_path, manifest_sha, batches)

    def test_schema_preflight_rejects_disabled_trigger(self) -> None:
        class Cursor:
            call = 0

            def execute(self, _query: str) -> None:
                self.call += 1

            def fetchone(self) -> tuple[object, ...]:
                if self.call == 1:
                    return (True,)
                if self.call == 2:
                    return ("text[]", False, None)
                if self.call == 3:
                    return (
                        backfill.EXPECTED_VECTOR_FUNCTION_EXACT_MD5,
                        backfill.EXPECTED_VECTOR_FUNCTION_CONFIG,
                    )
                if self.call == 5:
                    return (
                        23,
                        "D",
                        True,
                        "2 3 4",
                        False,
                        0,
                        "CREATE TRIGGER trg BEFORE INSERT OR UPDATE OF body_text, "
                        "fts_expansion_src, fts_core ON transcript_paragraphs FOR EACH ROW "
                        "EXECUTE FUNCTION body_search_vectors_trigger()",
                    )
                raise AssertionError(f"unexpected fetchone call {self.call}")

            def fetchall(self) -> list[tuple[object, ...]]:
                if self.call == 4:
                    return [
                        ("body_text", 2),
                        ("fts_expansion_src", 3),
                        ("fts_core", 4),
                    ]
                raise AssertionError(f"unexpected fetchall call {self.call}")

        with self.assertRaisesRegex(backfill.BackfillError, "exact approved narrowed form"):
            backfill._schema_preflight(Cursor())

    def test_database_target_accepts_only_exact_supabase_session_targets(self) -> None:
        project_ref = "abcdefghijklmnopqrst"
        valid = (
            {
                "host": f"db.{project_ref}.supabase.co",
                "user": "postgres",
                "port": "5432",
                "dbname": "postgres",
                "sslmode": "verify-full",
            },
            {
                "host": "aws-0-ap-south-1.pooler.supabase.com",
                "user": f"postgres.{project_ref}",
                "port": "5432",
                "dbname": "postgres",
                "sslmode": "require",
            },
        )
        for conninfo in valid:
            with self.subTest(conninfo=conninfo):
                backfill._validate_database_conninfo(conninfo, project_ref)

    def test_database_target_rejects_spoofed_or_unsafe_targets(self) -> None:
        project_ref = "abcdefghijklmnopqrst"
        base = {
            "host": "attacker.example",
            "user": f"postgres.{project_ref}",
            "port": "5432",
            "dbname": "postgres",
            "sslmode": "require",
        }
        invalid = (
            base,
            {**base, "host": "aws-0-ap-south-1.pooler.supabase.com", "port": "6543"},
            {**base, "host": "aws-0-ap-south-1.pooler.supabase.com", "dbname": "other"},
            {**base, "host": "aws-0-ap-south-1.pooler.supabase.com", "sslmode": "prefer"},
            {
                **base,
                "host": "aws-0-ap-south-1.pooler.supabase.com",
                "hostaddr": "127.0.0.1",
            },
            {
                **base,
                "host": "aws-0-ap-south-1.pooler.supabase.com",
                "hostaddr": "",
            },
            {
                **base,
                "host": "aws-0-ap-south-1.pooler.supabase.com",
                "service": "hidden-target",
            },
            {
                **base,
                "host": "aws-0-ap-south-1.pooler.supabase.com",
                "servicefile": "C:/tmp/pg_service.conf",
            },
            {
                **base,
                "host": f"db.{project_ref}.supabase.co",
                "user": f"postgres.{project_ref}",
            },
            {
                "host": f"db.{project_ref}.supabase.co",
                "user": "postgres",
                "dbname": "postgres",
                "sslmode": "require",
            },
        )
        for conninfo in invalid:
            with self.subTest(conninfo=conninfo):
                with self.assertRaises(backfill.BackfillError):
                    backfill._validate_database_conninfo(conninfo, project_ref)

    def test_database_target_rejects_ambient_libpq_routing(self) -> None:
        with patch.dict("os.environ", {"PGHOSTADDR": "127.0.0.1"}, clear=False):
            with self.assertRaisesRegex(backfill.BackfillError, "apply environment"):
                backfill._validate_database_target(
                    "postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/"
                    "postgres?sslmode=require",
                    "abcdefghijklmnopqrst",
                )


if __name__ == "__main__":
    unittest.main()
