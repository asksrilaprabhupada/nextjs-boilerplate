-- ============================================================================
-- Transcript speaker attribution: additive columns + deterministic backfill
-- ============================================================================
--
-- WHY THIS MATTERS MORE THAN RANKING. Of 144,438 transcript paragraphs, 65,429
-- carry an explicit "Name:" label — and only ~33,726 of those name Śrīla
-- Prabhupāda. Roughly 31,700 labelled paragraphs are guests, reporters and
-- visitors speaking. With no speaker column, nothing downstream could tell them
-- apart: for "BG 18.66" the top-ranked result was an evening darśana in Tehran,
-- and a devotee could stand up in a morning class and quote a visitor's words
-- as Śrīla Prabhupāda's. Ranking bugs are quality; this is truth.
--
-- STRICTLY ADDITIVE AND REVERSIBLE. Two nullable columns; no existing column is
-- modified, no row is deleted, no embedding or index is touched. Reversal is
-- two DROP COLUMNs.
--
-- DETERMINISTIC, NO MODEL. The speaker is read off the paragraph's own text by
-- a deliberately narrow regex. The unlabelled majority is marked 'unknown' and
-- displayed as unknown: an unlabelled continuation paragraph USUALLY belongs to
-- the previous speaker, but "usually" is not good enough for attribution. A
-- future pass can do better; a wrong attribution cannot be undone in someone's
-- memory.
--
-- APPLY NOTE: run via execute_sql (apply_migration silently fails on this
-- project). If the labelled-turns UPDATE times out, run it in id-keyset batches
-- (WHERE id > <last seen> ORDER BY id LIMIT 20000) — each statement here is
-- idempotent, so partial progress is safe to resume.
-- ============================================================================

ALTER TABLE public.transcript_paragraphs
  ADD COLUMN IF NOT EXISTS speaker text,
  ADD COLUMN IF NOT EXISTS speaker_confidence text;  -- 'labelled' | 'inherited' | 'unknown'

COMMENT ON COLUMN public.transcript_paragraphs.speaker IS
  'Speaker of this paragraph, read deterministically from its own "Name:" prefix. '
  'NULL means no explicit label — NOT assumed to be Śrīla Prabhupāda. '
  'Canonical value for him: ''Śrīla Prabhupāda''. Added 2026-08-01.';
COMMENT ON COLUMN public.transcript_paragraphs.speaker_confidence IS
  '''labelled'' = explicit Name: prefix at paragraph start; ''unknown'' = no label '
  '(honestly unidentified); ''inherited'' reserved for a future continuation pass. '
  'Added 2026-08-01.';

-- Explicitly labelled turns. The regex is deliberately narrow: a capitalised
-- name, diacritics allowed, at most ~35 characters, followed by a colon at the
-- very start of the paragraph. Anything looser starts matching sentences.
UPDATE public.transcript_paragraphs
SET speaker = btrim(substring(body_text from '^([A-Z][A-Za-zāīūṛṅñṭḍṇśṣḥṁ. -]{1,34}):')),
    speaker_confidence = 'labelled'
WHERE body_text ~ '^[A-Z][A-Za-zāīūṛṅñṭḍṇśṣḥṁ. -]{1,34}:'
  AND speaker IS NULL;

-- Normalise the many spellings of his name to one canonical value.
UPDATE public.transcript_paragraphs
SET speaker = 'Śrīla Prabhupāda'
WHERE speaker IN ('Prabhupāda','Prabhupada','Srila Prabhupada','Śrīla Prabhupāda');

-- Everything else is honestly unknown. It is NOT assumed to be his.
UPDATE public.transcript_paragraphs
SET speaker_confidence = 'unknown'
WHERE speaker IS NULL;

-- ---------------------------------------------------------------------------
-- Verification. Expected orders of magnitude: ~33,700 rows at the canonical
-- name, ~31,700 at other named speakers, the rest 'unknown'. A migration that
-- reports success without checking is how columns rot unnoticed.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  n_his bigint;
  n_other bigint;
  n_unknown bigint;
  n_unset bigint;
BEGIN
  SELECT count(*) INTO n_his FROM public.transcript_paragraphs
    WHERE speaker = 'Śrīla Prabhupāda';
  SELECT count(*) INTO n_other FROM public.transcript_paragraphs
    WHERE speaker IS NOT NULL AND speaker <> 'Śrīla Prabhupāda';
  SELECT count(*) INTO n_unknown FROM public.transcript_paragraphs
    WHERE speaker_confidence = 'unknown';
  SELECT count(*) INTO n_unset FROM public.transcript_paragraphs
    WHERE speaker_confidence IS NULL;
  RAISE NOTICE 'speaker backfill: % his, % other named, % unknown, % unset',
    n_his, n_other, n_unknown, n_unset;
  IF n_unset > 0 THEN
    RAISE EXCEPTION '% transcript paragraphs left with no speaker_confidence', n_unset;
  END IF;
END
$verify$;
