from __future__ import annotations

from copy import deepcopy
from dataclasses import fields
from hashlib import sha256
from pathlib import Path
import sys
import unittest


SCRIPT_DIRECTORY = Path(__file__).resolve().parents[1]
if str(SCRIPT_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIRECTORY))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from mapper import (  # noqa: E402
    CANONICAL_PRABHUPADA,
    UNKNOWN_SPEAKER,
    CorpusStats,
    MappingResult,
    TranscriptOrderError,
    TranscriptParagraph,
    canonical_json,
    classify_line,
    map_corpus,
    map_transcript,
    map_transcripts,
)
from screenshot_fixtures import (  # noqa: E402
    SCREENSHOT_1975_BODY,
    SCREENSHOT_1975_CHAIN,
    SCREENSHOT_1976_BODY,
    SCREENSHOT_1976_CHAIN,
)


def paragraph(
    paragraph_id: str,
    number: int,
    body: str,
    transcript_id: str | None = "transcript-a",
) -> TranscriptParagraph:
    return TranscriptParagraph(
        id=paragraph_id,
        transcript_id=transcript_id,
        paragraph_number=number,
        body_text=body,
    )


class ClassifierTests(unittest.TestCase):
    def test_prabhupada_variants_canonicalize(self) -> None:
        for line in (
            "Prabhupāda: Words.",
            "Prabhupada: Words.",
            "Prahupada: Words.",
            "Prabhuapda: Words.",
            "Pprabhupada: Words.",
            "Srila Prabhupada: Words.",
            "Śrīla Prabhupāda (1): Words.",
            "His Divine Grace A. C. Bhaktivedanta Swami Prabhupāda: Words.",
        ):
            with self.subTest(line=line):
                classification = classify_line(line)
                self.assertEqual(classification.kind, "proved")
                self.assertEqual(classification.speakers, (CANONICAL_PRABHUPADA,))

    def test_role_name_no_space_standalone_and_fullwidth_boundaries(self) -> None:
        cases = {
            "Devotees：Jaya.": "Devotees",
            "Guest:Hello.": "Guest",
            "Indian man: Yes.": "Indian man",
            "Guest (1): Yes.": "Guest (1)",
            "Indian man(2): Yes.": "Indian man (2)",
            "Pradyumna:": "Pradyumna",
        }
        for line, expected in cases.items():
            with self.subTest(line=line):
                classification = classify_line(line)
                self.assertEqual(classification.kind, "proved")
                self.assertEqual(classification.speakers, (expected,))

    def test_plausible_but_unproved_boundaries_are_unrecognized(self) -> None:
        for line in (
            "mystery person: Text.",
            "Guest [unclear]: Text.",
            "Ambassador Daniel Patrick Moynihan: Text.",
        ):
            with self.subTest(line=line):
                self.assertEqual(classify_line(line).kind, "unrecognized")

    def test_non_label_colons_remain_prose(self) -> None:
        for line in (
            "10:30 is the scheduled time.",
            "https://example.test/archive",
            "This ordinary sentence has far too many words before the colon: prose.",
            "That is explained in the Bhagavad-gītā: it is ordinary prose.",
            "Therefore: this is still the proved speaker's prose.",
            "But: this is not a speaker named But.",
            "Nothing with a colon here.",
        ):
            with self.subTest(line=line):
                self.assertEqual(classify_line(line).kind, "prose")

    def test_audited_glossary_and_verse_prefixes_remain_prose(self) -> None:
        for line in (
            "Aham: the Sanskrit pronoun is being explained.",
            "Yantra: this word is being defined.",
            "Nitya-siddha: a glossary explanation follows.",
            "Akhila-bandha-muktaye: the verse continues here.",
            "Bahu-sambhavānte: a Sanskrit phrase is being explained.",
            "Nidrayā hriyate naktam: a Sanskrit quotation continues.",
            "One: the first verse point.",
            "Fifty: the numbered recitation continues.",
            "Twenty-eight: the numbered recitation continues.",
            "Verse number 10: recitation text.",
        ):
            with self.subTest(line=line):
                self.assertEqual(classify_line(line).kind, "prose")

    def test_non_speech_editorial_headings_are_not_unknown_speakers(self) -> None:
        for line in (
            "Introduction: Editorial opening.",
            "Translation: Text.",
            "Audio file: unavailable.",
            "Type: Lecture.",
        ):
            with self.subTest(line=line):
                classification = classify_line(line)
                self.assertEqual(classification.kind, "editorial")
                self.assertEqual(classification.speakers, ())

    def test_explicit_unknown_speech_headings_remain_unknown_boundaries(self) -> None:
        for line in (
            "Question: Who am I?",
            "Answer: The reply.",
            "Speaker not identified: A recorded voice.",
        ):
            with self.subTest(line=line):
                classification = classify_line(line)
                self.assertEqual(classification.kind, "unrecognized")
                self.assertEqual(classification.speakers, ())

    def test_independently_proved_composite_labels_split_in_order(self) -> None:
        cases = {
            "Prabhupāda and Devotee: Together.": (
                CANONICAL_PRABHUPADA,
                "Devotee",
            ),
            "Prabhupāda, Brahmānanda: Together.": (
                CANONICAL_PRABHUPADA,
                "Brahmānanda",
            ),
            "Jayatīrtha and Prabhupāda: Together.": (
                "Jayatīrtha",
                CANONICAL_PRABHUPADA,
            ),
        }
        for line, expected in cases.items():
            with self.subTest(line=line):
                classification = classify_line(line)
                self.assertEqual(classification.kind, "proved")
                self.assertEqual(classification.speakers, expected)

        self.assertEqual(
            classify_line("Śrutakīrti and Unproved Name: Together.").kind,
            "unrecognized",
        )

    def test_audited_aliases_and_compact_role_numbers_canonicalize(self) -> None:
        self.assertEqual(classify_line("Yaduvara: Yes.").speakers, ("Yadubara",))
        self.assertEqual(classify_line("Yadubara: Yes.").speakers, ("Yadubara",))
        self.assertEqual(classify_line("Guest2: Yes.").speakers, ("Guest (2)",))

    def test_reader_headings_and_numbered_lines_remain_prose(self) -> None:
        for line in (
            "Text 2. Translation: The reader continues.",
            "Text 3. Translation: The reader continues.",
            "Twenty-eight: the numbered recitation continues.",
        ):
            with self.subTest(line=line):
                self.assertEqual(classify_line(line).kind, "prose")

    def test_audited_recurrent_person_labels_are_proved_exactly(self) -> None:
        labels = (
            "Acyutananda",
            "Atreya Rsi",
            "Bhakti Caru",
            "Birabhadra",
            "Dhananjaya",
            "Gargamuni",
            "Giriraja",
            "Gopala Krsna",
            "Hamsaduta",
            "Hari Sauri",
            "Janardana",
            "Jayadvaita",
            "Jayapataka",
            "Jayatirtha",
            "Kirtanananda",
            "Nitai",
            "Pancadravida",
            "Paramahamsa",
            "Revatinandana",
            "Sastriji",
            "Satadhanya",
            "Svarupa Damodara",
            "Upendra",
            "Visnujana",
            "Yamuna",
            "Yasodanandana",
            "Yasomatinandana",
            "Yogesvara",
            "Yadubara",
        )
        for label in labels:
            with self.subTest(label=label):
                classification = classify_line(f"{label}: A literal turn.")
                self.assertEqual(classification.kind, "proved")
                self.assertEqual(classification.speakers, (label,))

    def test_audited_recurrent_names_do_not_promote_another_ambiguous_label(self) -> None:
        result = map_transcript(
            (
                paragraph(
                    "one",
                    1,
                    "Nitāi: A proved audited turn.\n"
                    "Carla: Still structurally unsupported.\n"
                    "Upendra: Another proved audited turn.",
                ),
            )
        )[0]
        self.assertEqual(
            result.speaker_names,
            ("Nitāi", UNKNOWN_SPEAKER, "Upendra"),
        )
        self.assertEqual(
            result.suspicious_codes,
            ("unrecognized_boundary:carla",),
        )

    def test_one_original_anchor_plus_one_audited_name_does_not_promote(self) -> None:
        result = map_transcript(
            (
                paragraph(
                    "one",
                    1,
                    "Prabhupāda: Original anchor.\n"
                    "Carla: Still structurally unsupported.\n"
                    "Nitāi: Proved audited turn.",
                ),
            )
        )[0]
        self.assertEqual(
            result.speaker_names,
            (CANONICAL_PRABHUPADA, UNKNOWN_SPEAKER, "Nitāi"),
        )
        self.assertEqual(
            result.suspicious_codes,
            ("unrecognized_boundary:carla",),
        )

    def test_repeated_ambiguous_name_separated_only_by_audited_turn_stays_unknown(self) -> None:
        results = map_transcript(
            (
                paragraph("one", 1, "Carla: First unsupported turn."),
                paragraph("two", 2, "Nitāi: Proved audited turn."),
                paragraph("three", 3, "Carla: Repeated but still unsupported."),
            )
        )
        self.assertEqual(results[0].speaker_names, ())
        self.assertEqual(results[2].speaker_names, ())
        self.assertEqual(
            results[2].suspicious_codes,
            ("unrecognized_boundary:carla",),
        )

    def test_reader_heading_and_numbered_verse_keep_proved_reader(self) -> None:
        results = map_transcript(
            (
                paragraph("one", 1, "Upendra: Begins reading."),
                paragraph(
                    "two",
                    2,
                    "Text 3. Translation: A translated verse.\n"
                    "Twenty-eight: A numbered continuation.",
                ),
            )
        )
        self.assertEqual(results[1].speaker_names, ("Upendra",))
        self.assertEqual(results[1].evidence_modes, ("inherited",))
        self.assertEqual(results[1].suspicious_codes, ())

    def test_live_reader_heading_regression_rows_exclude_false_speakers(self) -> None:
        text_three = map_transcript(
            (
                paragraph(
                    "859e79b4-b0ad-41ae-ad67-87f02cd39e58",
                    1,
                    'Prabhupāda: In the Bible also it is said, "God said, '
                    "'Let there be creation,' and there was creation.\"\n"
                    "Yes. Go on.\n"
                    'Upendra: "That is the verdict of Veda."\n'
                    'Text 3. Translation: "It is conceived that all the universal '
                    'planetary system are situated on the extensive bodily features."',
                ),
            )
        )[0]
        self.assertEqual(
            text_three.speaker_names,
            (CANONICAL_PRABHUPADA, "Upendra"),
        )
        self.assertNotIn(UNKNOWN_SPEAKER, text_three.speaker_names)
        self.assertEqual(text_three.suspicious_codes, ())

        verse_twenty_eight = map_transcript(
            (
                paragraph(
                    "5af17030-6e40-442c-9011-2546631cc0db",
                    1,
                    "Prabhupāda: Yes.\n"
                    'Viṣṇujana: Verse twenty-seven: "The yogī whose mind is fixed."\n'
                    'Twenty-eight: "Steady in the self, being freed from all material '
                    'contamination."',
                ),
            )
        )[0]
        self.assertEqual(
            verse_twenty_eight.speaker_names,
            (CANONICAL_PRABHUPADA, "Viṣṇujana"),
        )
        self.assertNotIn(UNKNOWN_SPEAKER, verse_twenty_eight.speaker_names)
        self.assertEqual(verse_twenty_eight.suspicious_codes, ())

        text_two = map_transcript(
            (
                paragraph(
                    "fafd7746-0e6e-4cc1-bec9-0dfab4be4bca",
                    1,
                    'Upendra: "This part of the spiritual sky is called the '
                    'mahat-tattva."',
                ),
                paragraph(
                    "b2a5cf44-98f9-4007-85cc-cc1432062df6",
                    2,
                    'Text 2. Translation: "Another plenary part of the puruṣa is '
                    'lying down within the water of the universe."',
                ),
            )
        )[1]
        self.assertEqual(text_two.speaker_names, ("Upendra",))
        self.assertEqual(text_two.evidence_modes, ("inherited",))
        self.assertEqual(text_two.suspicious_codes, ())

    def test_no_colon_alternate_translation_form_is_unrecognized(self) -> None:
        classification = classify_line(
            'Pradyumna = Translation = "When one enters the transcendental world."'
        )
        self.assertEqual(classification.kind, "unrecognized")
        self.assertEqual(classification.raw_label, "Pradyumna = Translation")
        self.assertIn("transcendental world", classification.remainder)


class TranscriptMappingTests(unittest.TestCase):
    def test_audited_glossary_labels_do_not_clear_proved_carry(self) -> None:
        result = map_transcript(
            (
                paragraph("one", 1, "Prabhupāda: Proved."),
                paragraph(
                    "two",
                    2,
                    "Aham: a glossary definition.\n"
                    "Yantra: another definition.\n"
                    "Nitya-siddha: another glossary entry.\n"
                    "Akhila-bandha-muktaye: a verse explanation.\n"
                    "Bahu-sambhavānte: a Sanskrit phrase is explained.\n"
                    "One: the first numbered point.\n"
                    "Fifty: the numbered recitation continues.",
                ),
            )
        )[1]
        self.assertEqual(result.speaker_names, (CANONICAL_PRABHUPADA,))
        self.assertEqual(result.evidence_modes, ("inherited",))
        self.assertEqual(result.suspicious_codes, ())

    def test_sparse_ambiguous_name_clears_instead_of_inheriting(self) -> None:
        result = map_transcript(
            (
                paragraph("one", 1, "Prabhupāda: Proved."),
                paragraph("two", 2, "Carla: A single structurally unsupported turn."),
            )
        )[1]
        self.assertEqual(result.speaker_names, ())
        self.assertEqual(result.before_speaker, CANONICAL_PRABHUPADA)
        self.assertIsNone(result.after_speaker)
        self.assertEqual(result.evidence_modes, ("unknown", "suspicious"))

    def test_rare_names_are_never_promoted_inside_turn_dense_rows(self) -> None:
        for rare_name in ("Carla", "Andy", "Bicyclist", "Local"):
            with self.subTest(rare_name=rare_name):
                result = map_transcript(
                    (
                        paragraph(
                            "one",
                            1,
                            "Prabhupāda: First proved turn.\n"
                            f"{rare_name}: Rare human turn.\n"
                            "Prabhupāda: Second proved turn.",
                        ),
                    )
                )[0]
                self.assertEqual(
                    result.speaker_names,
                    (CANONICAL_PRABHUPADA, UNKNOWN_SPEAKER),
                )
                self.assertEqual(
                    result.evidence_modes,
                    ("explicit", "mixed", "unknown", "suspicious"),
                )
                self.assertEqual(
                    result.suspicious_codes,
                    (f"unrecognized_boundary:{rare_name.lower()}",),
                )

    def test_repeated_ambiguous_turn_label_is_never_promoted(self) -> None:
        results = map_transcript(
            (
                paragraph("one", 1, "Carla: First question."),
                paragraph("two", 2, "Prabhupāda: Answer."),
                paragraph("three", 3, "Carla: Follow-up question."),
            )
        )
        self.assertEqual(results[0].speaker_names, ())
        self.assertEqual(results[2].speaker_names, ())
        self.assertEqual(results[2].before_speaker, CANONICAL_PRABHUPADA)

    def test_verse_fragments_between_proved_turns_never_become_speakers(self) -> None:
        for fragment in (
            "Surabhīr Abhipālayantam",
            "Caraṇāravindam",
            "Kuruśreṣṭha",
        ):
            with self.subTest(fragment=fragment):
                result = map_transcript(
                    (
                        paragraph(
                            "one",
                            1,
                            "Prabhupāda: First proved turn.\n"
                            f"{fragment}: Verse material.\n"
                            "Prabhupāda: Second proved turn.",
                        ),
                    )
                )[0]
                self.assertEqual(
                    result.speaker_names,
                    (CANONICAL_PRABHUPADA, UNKNOWN_SPEAKER),
                )
                self.assertIn("suspicious", result.evidence_modes)

    def test_uncertain_human_boundary_clears_carry(self) -> None:
        for label in (
            "Guest [unclear]",
            "Ambassador Daniel Patrick Moynihan",
        ):
            with self.subTest(label=label):
                result = map_transcript(
                    (
                        paragraph("one", 1, "Prabhupāda: Proved."),
                        paragraph("two", 2, f"{label}: A question."),
                    )
                )[1]
                self.assertEqual(result.speaker_names, ())
                self.assertIsNone(result.after_speaker)
                self.assertIn("suspicious", result.evidence_modes)

    def test_metadata_does_not_fabricate_unknown_speaker(self) -> None:
        result = map_transcript(
            (
                paragraph(
                    "one",
                    1,
                    "Dated: 1975.\nLocation: Vṛndāvana.\nAudio file: archive.\n"
                    "Prabhupāda: Spoken words.",
                ),
            )
        )[0]
        self.assertEqual(result.speaker_names, (CANONICAL_PRABHUPADA,))
        self.assertNotIn(UNKNOWN_SPEAKER, result.speaker_names)
        self.assertEqual(result.suspicious_codes, ())

    def test_repeated_ambiguous_gloss_does_not_self_prove_without_hard_turn(self) -> None:
        results = map_transcript(
            (
                paragraph("one", 1, "Tattvam: First ambiguous glossary entry."),
                paragraph("two", 2, "Translation: Editorial material."),
                paragraph("three", 3, "Jñānam: Another ambiguous glossary entry."),
                paragraph("four", 4, "Tattvam: The glossary term is repeated."),
            )
        )
        self.assertEqual([result.speaker_names for result in results], [(), (), (), ()])
        self.assertTrue(all(result.after_speaker is None for result in results))
        self.assertIn("unknown", results[0].evidence_modes)
        self.assertEqual(results[1].evidence_modes, ())
        self.assertIn("unknown", results[2].evidence_modes)
        self.assertIn("unknown", results[3].evidence_modes)

    def test_long_unnamed_continuations_inherit_across_rows(self) -> None:
        rows = (
            paragraph("one", 1, "Prabhupāda:\r\nOpening words."),
            paragraph("two", 2, "A long unnamed continuation.\nIt continues again."),
            paragraph("three", 3, "Still the same proved speaker."),
        )
        results = map_transcript(rows)
        self.assertEqual(results[1].speaker_names, (CANONICAL_PRABHUPADA,))
        self.assertEqual(results[1].evidence_modes, ("inherited",))
        self.assertEqual(results[2].before_speaker, CANONICAL_PRABHUPADA)
        self.assertEqual(results[2].after_speaker, CANONICAL_PRABHUPADA)

    def test_guest_and_prabhupada_transitions_switch_immediately(self) -> None:
        results = map_transcript(
            (
                paragraph("one", 1, "Guest: A question."),
                paragraph("two", 2, "Unnamed guest continuation."),
                paragraph("three", 3, "Prabhupāda: An answer."),
                paragraph("four", 4, "Unnamed answer continuation."),
                paragraph("five", 5, "Guest: Another question."),
            )
        )
        self.assertEqual(results[1].speaker_names, ("Guest",))
        self.assertEqual(results[2].speaker_names, (CANONICAL_PRABHUPADA,))
        self.assertEqual(results[3].speaker_names, (CANONICAL_PRABHUPADA,))
        self.assertEqual(results[4].speaker_names, ("Guest",))
        self.assertEqual(results[4].before_speaker, CANONICAL_PRABHUPADA)
        self.assertEqual(results[4].after_speaker, "Guest")

    def test_repeated_back_and_forth_is_ordered_and_deduplicated(self) -> None:
        result = map_transcript(
            (
                paragraph(
                    "one",
                    1,
                    "Guest: First.\nPrabhupāda: Reply.\nGuest: Again.\nDevotees: Jaya.\nPrabhupada: Last.",
                ),
            )
        )[0]
        self.assertEqual(
            result.speaker_names,
            ("Guest", CANONICAL_PRABHUPADA, "Devotees"),
        )
        self.assertEqual(result.evidence_modes, ("explicit", "mixed"))
        self.assertEqual(result.after_speaker, CANONICAL_PRABHUPADA)

    def test_leading_inherited_text_then_explicit_switch_records_both(self) -> None:
        results = map_transcript(
            (
                paragraph("one", 1, "Guest: Earlier."),
                paragraph("two", 2, "Continuation first.\nPrabhupāda: Then the answer."),
            )
        )
        self.assertEqual(results[1].speaker_names, ("Guest", CANONICAL_PRABHUPADA))
        self.assertEqual(results[1].evidence_modes, ("explicit", "inherited", "mixed"))

    def test_leading_unknown_before_known_speaker_preserves_sentinel_order(self) -> None:
        result = map_transcript(
            (
                paragraph(
                    "one",
                    1,
                    "Unattributed opening words.\nPrabhupāda: Proved answer.",
                ),
            )
        )[0]
        self.assertEqual(result.speaker_names, (UNKNOWN_SPEAKER, CANONICAL_PRABHUPADA))
        self.assertEqual(result.evidence_modes, ("explicit", "mixed", "unknown"))

    def test_unrecognized_boundary_clears_inheritance_until_new_proof(self) -> None:
        results = map_transcript(
            (
                paragraph("one", 1, "Prabhupāda: Proved."),
                paragraph("two", 2, "Carla: A recorded question."),
                paragraph("three", 3, "This cannot inherit the earlier speaker."),
                paragraph("four", 4, "Devotee: New proof."),
            )
        )
        self.assertEqual(results[1].speaker_names, ())
        self.assertEqual(results[1].after_speaker, None)
        self.assertEqual(results[1].evidence_modes, ("unknown", "suspicious"))
        self.assertEqual(
            results[1].suspicious_codes,
            ("unrecognized_boundary:carla",),
        )
        self.assertEqual(results[2].speaker_names, ())
        self.assertEqual(results[2].before_speaker, None)
        self.assertEqual(results[2].evidence_modes, ("unknown",))
        self.assertEqual(results[3].speaker_names, ("Devotee",))

    def test_alternate_translation_line_clears_then_standalone_label_reproves(self) -> None:
        results = map_transcript(
            (
                paragraph("one", 1, "Guest: Earlier proof."),
                paragraph(
                    "two",
                    2,
                    'Pradyumna = Translation = "When one enters the transcendental world."\nPrabhupāda:\nProved answer.',
                ),
            )
        )
        target = results[1]
        self.assertEqual(
            target.speaker_names,
            (UNKNOWN_SPEAKER, CANONICAL_PRABHUPADA),
        )
        self.assertEqual(
            target.evidence_modes,
            ("explicit", "mixed", "unknown", "suspicious"),
        )
        self.assertEqual(
            target.suspicious_codes,
            ("unrecognized_boundary:pradyumna_translation",),
        )
        self.assertEqual(target.after_speaker, CANONICAL_PRABHUPADA)

    def test_known_and_unknown_portions_include_sentinel_once(self) -> None:
        result = map_transcript(
            (
                paragraph(
                    "one",
                    1,
                    "Prabhupāda: Proved.\nSpeaker not identified: Unknown words.\nMore unknown words.",
                ),
            )
        )[0]
        self.assertEqual(result.speaker_names, (CANONICAL_PRABHUPADA, UNKNOWN_SPEAKER))
        self.assertEqual(
            result.evidence_modes,
            ("explicit", "mixed", "unknown", "suspicious"),
        )
        self.assertIsNone(result.after_speaker)

    def test_wholly_unknown_nonempty_paragraph_persists_empty_array(self) -> None:
        result = map_transcript((paragraph("one", 1, "No proved speaker here."),))[0]
        self.assertEqual(result.speaker_names, ())
        self.assertEqual(result.evidence_modes, ("unknown",))
        self.assertIsNone(result.after_speaker)

    def test_empty_paragraph_does_not_clear_active_speaker(self) -> None:
        results = map_transcript(
            (
                paragraph("one", 1, "Prabhupāda: Proved."),
                paragraph("two", 2, " \n\t"),
                paragraph("three", 3, "Unnamed continuation."),
            )
        )
        self.assertEqual(results[1].speaker_names, ())
        self.assertEqual(results[1].evidence_modes, ())
        self.assertEqual(results[1].after_speaker, CANONICAL_PRABHUPADA)
        self.assertEqual(results[2].speaker_names, (CANONICAL_PRABHUPADA,))

    def test_transcript_state_resets_and_result_order_is_canonical(self) -> None:
        results = map_transcripts(
            (
                paragraph("b-one", 1, "Unproved opening.", "transcript-b"),
                paragraph("a-two", 2, "Unnamed continuation.", "transcript-a"),
                paragraph("a-one", 1, "Prabhupāda: Proved.", "transcript-a"),
            )
        )
        self.assertEqual([result.id for result in results], ["a-one", "a-two", "b-one"])
        self.assertEqual(results[1].speaker_names, (CANONICAL_PRABHUPADA,))
        self.assertEqual(results[2].speaker_names, ())
        self.assertIsNone(results[2].before_speaker)

    def test_null_transcript_ids_are_isolated(self) -> None:
        results = map_transcripts(
            (
                paragraph("a", 1, "Prabhupāda: Proved.", None),
                paragraph("b", 2, "Must not inherit.", None),
            )
        )
        self.assertEqual(results[0].speaker_names, (CANONICAL_PRABHUPADA,))
        self.assertEqual(results[1].speaker_names, ())
        self.assertIsNone(results[1].before_speaker)

    def test_order_failures_raise_instead_of_inventing_inheritance(self) -> None:
        with self.assertRaises(TranscriptOrderError):
            map_transcript(
                (
                    paragraph("one", 1, "Guest: One."),
                    paragraph("two", 1, "Guest: Two."),
                )
            )
        with self.assertRaises(TranscriptOrderError):
            map_corpus(
                [
                    {
                        "id": "null-order",
                        "transcript_id": "a",
                        "paragraph_number": None,
                        "body_text": "Guest: One.",
                    }
                ]
            )
        with self.assertRaisesRegex(TranscriptOrderError, "starts at paragraph"):
            map_transcript((paragraph("partial", 2, "Guest: Missing predecessor."),))
        with self.assertRaisesRegex(TranscriptOrderError, "paragraph-number gap"):
            map_transcript(
                (
                    paragraph("one", 1, "Guest: One."),
                    paragraph("three", 3, "Inherited across a missing row."),
                )
            )
        with self.assertRaisesRegex(TranscriptOrderError, "positive integer"):
            map_transcript((paragraph("zero", 0, "Guest: Invalid order."),))


class ScreenshotFixtureTests(unittest.TestCase):
    def test_1975_target_inherits_prabhupada(self) -> None:
        self.assertIn("Sa vai manaḥ kṛṣṇa", SCREENSHOT_1975_BODY)
        results, _ = map_corpus([dict(row) for row in SCREENSHOT_1975_CHAIN])
        target = next(result for result in results if result.id == "screenshot-1975-target")
        self.assertEqual(target.speaker_names, (CANONICAL_PRABHUPADA,))
        self.assertEqual(target.evidence_modes, ("inherited",))

    def test_1976_target_is_prabhupada_then_devotees(self) -> None:
        self.assertIn("Devotees: Jaya. [end]", SCREENSHOT_1976_BODY)
        results, _ = map_corpus([dict(row) for row in SCREENSHOT_1976_CHAIN])
        target = next(result for result in results if result.id == "screenshot-1976-target")
        self.assertEqual(target.speaker_names, (CANONICAL_PRABHUPADA, "Devotees"))
        self.assertEqual(target.evidence_modes, ("explicit", "inherited", "mixed"))


class RunnerContractTests(unittest.TestCase):
    def test_map_corpus_contract_hashes_raw_body_and_ignores_extra_metadata(self) -> None:
        rows = [
            {
                "id": "one",
                "transcript_id": "a",
                "paragraph_number": 1,
                "body_text": "Prabhupāda:\r\nExact bytes.",
                "title": "A title that must not influence attribution",
                "location": "A location that must not influence attribution",
                "occasion": "An occasion that must not influence attribution",
            }
        ]
        original = deepcopy(rows)
        results, stats = map_corpus(rows)
        self.assertEqual(rows, original)
        self.assertEqual(results[0].speaker_names, (CANONICAL_PRABHUPADA,))
        self.assertEqual(
            results[0].body_sha256,
            sha256(rows[0]["body_text"].encode("utf-8")).hexdigest(),
        )
        self.assertEqual(
            set(results[0].to_record()),
            {
                "id",
                "transcriptId",
                "paragraphNumber",
                "bodySha256",
                "speakerNames",
                "beforeSpeaker",
                "afterSpeaker",
                "evidenceModes",
                "suspiciousCodes",
            },
        )
        self.assertIsInstance(stats, CorpusStats)

    def test_stats_count_overlapping_evidence_modes(self) -> None:
        results, stats = map_corpus(
            [
                {
                    "id": "one",
                    "transcript_id": "a",
                    "paragraph_number": 1,
                    "body_text": "Prabhupāda: Proved.",
                },
                {
                    "id": "two",
                    "transcript_id": "a",
                    "paragraph_number": 2,
                    "body_text": "Inherited.\nDevotee: Switch.",
                },
                {
                    "id": "three",
                    "transcript_id": "b",
                    "paragraph_number": 1,
                    "body_text": "Carla: Unknown.",
                },
            ]
        )
        self.assertEqual(len(results), 3)
        self.assertEqual(
            stats.to_record(),
            {
                "processedParagraphs": 3,
                "processedTranscripts": 2,
                "explicitParagraphs": 2,
                "inheritedParagraphs": 1,
                "mixedParagraphs": 1,
                "unknownParagraphs": 1,
                "suspiciousParagraphs": 1,
            },
        )

    def test_canonical_json_and_dataclass_surface_are_stable(self) -> None:
        result = MappingResult(
            id="one",
            transcript_id="a",
            paragraph_number=1,
            body_sha256="abc",
            speaker_names=(CANONICAL_PRABHUPADA,),
            before_speaker=None,
            after_speaker=CANONICAL_PRABHUPADA,
            evidence_modes=("explicit",),
            suspicious_codes=(),
        )
        serialized = canonical_json(result)
        self.assertIn("Śrīla Prabhupāda", serialized)
        self.assertNotIn("\\u015a", serialized)
        self.assertEqual(serialized, canonical_json(result))
        self.assertEqual(
            [field.name for field in fields(TranscriptParagraph)],
            ["id", "transcript_id", "paragraph_number", "body_text"],
        )

    def test_missing_required_field_fails_closed(self) -> None:
        with self.assertRaisesRegex(KeyError, "body_text"):
            map_corpus(
                [
                    {
                        "id": "one",
                        "transcript_id": "a",
                        "paragraph_number": 1,
                    }
                ]
            )


if __name__ == "__main__":
    unittest.main()
