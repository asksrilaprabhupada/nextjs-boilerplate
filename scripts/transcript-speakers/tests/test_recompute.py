from __future__ import annotations

import argparse
import importlib.util
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location(
    "transcript_speaker_recompute", SCRIPT_DIR / "recompute.py"
)
assert SPEC is not None and SPEC.loader is not None
recompute = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recompute)


TRANSCRIPT_ID = "10000000-0000-0000-0000-000000000001"


def _source_rows() -> list[dict[str, object]]:
    return [
        {
            "id": "20000000-0000-0000-0000-000000000001",
            "transcript_id": TRANSCRIPT_ID,
            "paragraph_number": 1,
            "body_text": "Prabhupada: private body one",
            "speaker_names": None,
        },
        {
            "id": "20000000-0000-0000-0000-000000000002",
            "transcript_id": TRANSCRIPT_ID,
            "paragraph_number": 2,
            "body_text": "continuation private body two",
            "speaker_names": ["Guest"],
        },
    ]


def _source() -> dict[str, object]:
    rows = _source_rows()
    return {
        "access": "test-read-only",
        "countAfter": len(rows),
        "countBefore": len(rows),
        "firstParagraphId": rows[0]["id"],
        "lastParagraphId": rows[-1]["id"],
        "projectRef": "local-test",
        "table": "public.transcript_paragraphs",
        "transcriptId": TRANSCRIPT_ID,
    }


class _Response:
    status_code = 200

    def __init__(
        self,
        payload: object | None = None,
        *,
        content_range: str | None = None,
    ) -> None:
        self._payload = payload
        self.headers = (
            {} if content_range is None else {"content-range": content_range}
        )

    def json(self) -> object:
        return self._payload


class _Session:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows
        self.head_params: list[dict[str, str]] = []
        self.get_params: list[dict[str, str]] = []

    def head(
        self,
        _endpoint: str,
        *,
        params: dict[str, str],
        headers: dict[str, str],
        timeout: object,
    ) -> _Response:
        del headers, timeout
        self.head_params.append(dict(params))
        return _Response(content_range=f"0-0/{len(self.rows)}")

    def get(
        self,
        _endpoint: str,
        *,
        params: dict[str, str],
        timeout: object,
    ) -> _Response:
        del timeout
        self.get_params.append(dict(params))
        return _Response(self.rows)


class RecomputeTests(unittest.TestCase):
    def test_entrypoints_require_the_pinned_runtime_before_io(self) -> None:
        dry_args = argparse.Namespace(
            artifact_dir=None,
            timeout_seconds=1.0,
            transcript_id=TRANSCRIPT_ID,
        )
        with mock.patch.object(
            recompute.backfill,
            "_verify_runtime_dependencies",
            side_effect=recompute.RecomputeError("dependency check"),
        ) as verify:
            with self.assertRaisesRegex(recompute.RecomputeError, "dependency check"):
                recompute.run_dry_run(dry_args)
            verify.assert_called_once_with(require_psycopg=False)

        apply_args = argparse.Namespace(
            artifact_dir=Path("unused"),
            execute_approved_recompute=True,
            transcript_id=TRANSCRIPT_ID,
        )
        with mock.patch.object(
            recompute.backfill,
            "_verify_runtime_dependencies",
            side_effect=recompute.RecomputeError("dependency check"),
        ) as verify:
            with self.assertRaisesRegex(recompute.RecomputeError, "dependency check"):
                recompute.run_apply(apply_args)
            verify.assert_called_once_with(require_psycopg=True)

    def test_fetch_is_exactly_transcript_filtered_and_bounded(self) -> None:
        rows = _source_rows()
        session = _Session(rows)

        observed, before, after = recompute._fetch_transcript(
            session, "https://example/rest", TRANSCRIPT_ID, 1.0
        )

        self.assertEqual(observed, rows)
        self.assertEqual((before, after), (2, 2))
        self.assertEqual(len(session.head_params), 2)
        self.assertTrue(
            all(
                params["transcript_id"] == f"eq.{TRANSCRIPT_ID}"
                for params in session.head_params + session.get_params
            )
        )
        self.assertEqual(
            session.get_params[0]["limit"], str(recompute.MAX_TRANSCRIPT_ROWS + 1)
        )
        self.assertNotIn("offset", session.get_params[0])

    def test_packet_freezes_both_states_and_excludes_body_text(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact_dir = Path(temporary)
            manifest_sha = recompute._build_artifacts(
                _source_rows(), TRANSCRIPT_ID, artifact_dir, _source()
            )

            manifest, loaded_sha, records = recompute._verify_frozen_packet(
                artifact_dir
            )

            self.assertEqual(loaded_sha, manifest_sha)
            self.assertEqual(manifest["transcriptInput"]["paragraphs"], 2)
            self.assertEqual(records[0]["currentSpeakerNames"], None)
            self.assertEqual(
                records[0]["desiredSpeakerNames"],
                [recompute.backfill.CANONICAL_PRABHUPADA],
            )
            self.assertEqual(records[1]["currentSpeakerNames"], ["Guest"])
            self.assertEqual(
                records[1]["desiredSpeakerNames"],
                [recompute.backfill.CANONICAL_PRABHUPADA],
            )
            for path in artifact_dir.iterdir():
                content = path.read_bytes()
                self.assertNotIn(b"private body", content)
                self.assertNotIn(b"body_text", content)

    def test_packet_binds_every_operator_file_and_optional_requirements(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact_dir = Path(temporary)
            recompute._build_artifacts(
                _source_rows(), TRANSCRIPT_ID, artifact_dir, _source()
            )
            manifest, _, _ = recompute._verify_frozen_packet(artifact_dir)
            observed = {item["path"] for item in manifest["codeFiles"]}
            expected = {
                recompute._relative_repo_path(path) for path in recompute._code_paths()
            }
            self.assertEqual(observed, expected)
            self.assertIn(
                recompute._relative_repo_path(recompute.SCRIPT_PATH), observed
            )
            self.assertIn(
                recompute._relative_repo_path(recompute.backfill.SCRIPT_PATH), observed
            )

    def test_contiguous_validation_rejects_gap_and_row_limit(self) -> None:
        gap = _source_rows()
        gap[1]["paragraph_number"] = 3
        with self.assertRaisesRegex(recompute.RecomputeError, "not complete"):
            recompute._canonicalize_single_transcript(gap, TRANSCRIPT_ID)

        repeated = []
        for number in range(1, recompute.MAX_TRANSCRIPT_ROWS + 2):
            repeated.append(
                {
                    "id": f"20000000-0000-0000-0000-{number:012d}",
                    "transcript_id": TRANSCRIPT_ID,
                    "paragraph_number": number,
                    "body_text": "body",
                    "speaker_names": None,
                }
            )
        with self.assertRaisesRegex(recompute.RecomputeError, "safety limit"):
            recompute._canonicalize_single_transcript(repeated, TRANSCRIPT_ID)

    def test_state_classification_accepts_only_whole_before_or_desired(self) -> None:
        records = [
            {"currentSpeakerNames": None, "desiredSpeakerNames": ["A"]},
            {"currentSpeakerNames": ["B"], "desiredSpeakerNames": ["A"]},
        ]
        self.assertEqual(
            recompute._classify_state([None, ["B"]], records), "frozen-current"
        )
        self.assertEqual(
            recompute._classify_state([["A"], ["A"]], records), "already-desired"
        )
        with self.assertRaisesRegex(recompute.RecomputeError, "mixed before/desired"):
            recompute._classify_state([None, ["A"]], records)
        with self.assertRaisesRegex(recompute.RecomputeError, "neither"):
            recompute._classify_state([["Third"], ["A"]], records)

    def test_apply_requires_exact_transcript_and_manifest_marker_before_database(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact_dir = Path(temporary)
            manifest_sha = recompute._build_artifacts(
                _source_rows(), TRANSCRIPT_ID, artifact_dir, _source()
            )
            args = argparse.Namespace(
                artifact_dir=artifact_dir,
                execute_approved_recompute=True,
                transcript_id=TRANSCRIPT_ID,
            )
            expected = f"{recompute.APPROVAL_PREFIX}{TRANSCRIPT_ID}:{manifest_sha}"
            with mock.patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(recompute.RecomputeError, "must exactly equal"):
                    recompute.run_apply(args)
            with mock.patch.dict(
                os.environ,
                {recompute.APPROVAL_ENV: expected, "DATABASE_URL": ""},
                clear=True,
            ):
                with self.assertRaisesRegex(recompute.RecomputeError, "DATABASE_URL"):
                    recompute.run_apply(args)

    def test_locked_row_validation_freezes_membership_order_identity_and_body(self) -> None:
        body = "body"
        records = [
            {
                "id": "20000000-0000-0000-0000-000000000001",
                "transcriptId": TRANSCRIPT_ID,
                "paragraphNumber": 1,
                "bodySha256": sha256(body.encode()).hexdigest(),
            }
        ]
        database = [
            (
                records[0]["id"],
                TRANSCRIPT_ID,
                1,
                body,
                ["A"],
            )
        ]
        self.assertEqual(
            recompute._validate_locked_rows(database, records), [["A"]]
        )
        with self.assertRaisesRegex(recompute.RecomputeError, "body_text drift"):
            recompute._validate_locked_rows(
                [(records[0]["id"], TRANSCRIPT_ID, 1, "changed", ["A"])], records
            )
        with self.assertRaisesRegex(recompute.RecomputeError, "membership"):
            recompute._validate_locked_rows([], records)

    def test_locked_apply_updates_only_speaker_names_and_verifies_in_transaction(self) -> None:
        body = "Prabhupada: body"
        paragraph_id = "20000000-0000-0000-0000-000000000001"
        records = [
            {
                "id": paragraph_id,
                "transcriptId": TRANSCRIPT_ID,
                "paragraphNumber": 1,
                "bodySha256": sha256(body.encode()).hexdigest(),
                "currentSpeakerNames": None,
                "desiredSpeakerNames": ["Srila Prabhupada"],
            }
        ]
        before = [(paragraph_id, TRANSCRIPT_ID, 1, body, None)]
        after = [(paragraph_id, TRANSCRIPT_ID, 1, body, ["Srila Prabhupada"])]

        class Transaction:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

        class Cursor:
            def __init__(self) -> None:
                self.queries: list[str] = []
                self.fetchall_values = [before, [(paragraph_id,)], after]

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def execute(self, query: str, params: object = None) -> None:
                del params
                self.queries.append(" ".join(query.split()))

            def fetchall(self):
                return self.fetchall_values.pop(0)

        class Connection:
            def __init__(self) -> None:
                self.cursor_value = Cursor()

            def transaction(self):
                return Transaction()

            def cursor(self):
                return self.cursor_value

        connection = Connection()
        observed = recompute._apply_locked_recompute(
            connection, TRANSCRIPT_ID, records
        )

        self.assertEqual(observed, ("frozen-current", 1, 0))
        joined = " ".join(connection.cursor_value.queries)
        self.assertIn("FOR UPDATE", joined)
        self.assertIn("SET speaker_names = desired.speaker_names", joined)
        self.assertNotIn("SET body_text", joined)
        self.assertIn("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", joined)
        self.assertEqual(connection.cursor_value.fetchall_values, [])

    def test_idempotent_locked_apply_performs_no_update(self) -> None:
        body = "body"
        paragraph_id = "20000000-0000-0000-0000-000000000001"
        desired = ["A"]
        records = [
            {
                "id": paragraph_id,
                "transcriptId": TRANSCRIPT_ID,
                "paragraphNumber": 1,
                "bodySha256": sha256(body.encode()).hexdigest(),
                "currentSpeakerNames": None,
                "desiredSpeakerNames": desired,
            }
        ]
        row = [(paragraph_id, TRANSCRIPT_ID, 1, body, desired)]

        class Context:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

        class Cursor(Context):
            def __init__(self) -> None:
                self.queries: list[str] = []
                self.values = [row, row]

            def execute(self, query: str, params: object = None) -> None:
                del params
                self.queries.append(" ".join(query.split()))

            def fetchall(self):
                return self.values.pop(0)

        class Connection:
            def __init__(self) -> None:
                self.cursor_value = Cursor()

            def transaction(self):
                return Context()

            def cursor(self):
                return self.cursor_value

        connection = Connection()
        observed = recompute._apply_locked_recompute(
            connection, TRANSCRIPT_ID, records
        )

        self.assertEqual(observed, ("already-desired", 0, 1))
        self.assertFalse(
            any(query.startswith("WITH desired AS") for query in connection.cursor_value.queries)
        )

    def test_result_artifact_is_written_only_as_a_body_free_commit_receipt(self) -> None:
        records = [{"id": "one"}, {"id": "two"}]
        with tempfile.TemporaryDirectory() as temporary:
            artifact_dir = Path(temporary)
            recompute._write_result(
                artifact_dir,
                manifest_sha="a" * 64,
                transcript_id=TRANSCRIPT_ID,
                records=records,
                state_mode="frozen-current",
                updated_rows=1,
                unchanged_rows=1,
            )

            result_bytes = (artifact_dir / recompute.RESULT_FILE).read_bytes()
            result = json.loads(result_bytes)
            self.assertEqual(result["result"], "committed")
            self.assertEqual(result["paragraphs"], 2)
            self.assertEqual(result["manifestSha256"], "a" * 64)
            self.assertNotIn(b"body", result_bytes)


if __name__ == "__main__":
    unittest.main()
