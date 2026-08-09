/**
 * Pure display model for the full-screen search loader.
 *
 * The progress helpers keep one integer value honest: a stage event can never
 * claim completion, and an older/lower event can never move the bar backwards.
 * The passage pool is deliberately static. Its English text was checked
 * against the linked BBT Vedabase translation on 2026-08-09; the owner must
 * still approve the selection and exact wording before this branch is merged.
 */
import type { SearchStageEvent, SearchStageKey } from "@/app/lib/types/01-search";
import {
  SEARCH_STAGE_ORDER,
  SEARCH_STAGE_PERCENT,
} from "@/app/lib/25-search-stage-events";

export const SEARCH_LOADER_INITIAL_PERCENT = 4;
export const SEARCH_LOADER_PRE_READY_MAX = 99;

const SEARCH_STAGE_NAMES: Readonly<Record<SearchStageKey, string>> = {
  understood: "Understand",
  searching: "Search",
  reranking: "Rerank",
  verifying: "Verify",
  weaving: "Weave",
};

export const SEARCH_LOADER_STAGES = Object.freeze(
  SEARCH_STAGE_ORDER.map((key) => Object.freeze({ key, name: SEARCH_STAGE_NAMES[key] })),
);

/** Optimistic display only, used when the browser cannot receive SSE frames. */
export const SEARCH_LOADER_FALLBACK_STAGES: readonly SearchStageEvent[] = Object.freeze([
  Object.freeze({ stage: "understood", pct: SEARCH_STAGE_PERCENT.understood, label: "Reading your question…" }),
  Object.freeze({ stage: "searching", pct: SEARCH_STAGE_PERCENT.searching, label: "Searching the library…" }),
  Object.freeze({ stage: "reranking", pct: SEARCH_STAGE_PERCENT.reranking, label: "Selecting relevant passages…" }),
  Object.freeze({ stage: "verifying", pct: SEARCH_STAGE_PERCENT.verifying, label: "Verifying every quote…" }),
  Object.freeze({ stage: "weaving", pct: SEARCH_STAGE_PERCENT.weaving, label: "Arranging the evidence…" }),
]);

/** Clamp an arbitrary target to the single integer shown by the loader. */
export function clampLoaderPercent(value: number, ready: boolean): number {
  if (ready) return 100;
  if (!Number.isFinite(value)) return SEARCH_LOADER_INITIAL_PERCENT;
  return Math.min(SEARCH_LOADER_PRE_READY_MAX, Math.max(0, Math.round(value)));
}

/** Apply a new target without ever regressing the displayed percentage. */
export function advanceLoaderPercent(
  current: number,
  requested: number,
  ready: boolean,
): number {
  if (ready) return 100;
  const safeCurrent = clampLoaderPercent(current, false);
  const safeRequested = clampLoaderPercent(requested, false);
  return Math.max(safeCurrent, safeRequested);
}

export interface PremaPassage {
  readonly id: string;
  /** Verbatim English wording; any removed editorial wrapper is recorded below. */
  readonly text: string;
  readonly work: "Bhakti-rasāmṛta-sindhu" | "Upadeśāmṛta";
  readonly reference: string;
  readonly author: "Śrīla Rūpa Gosvāmī";
  readonly translatorAttribution: "Translation by His Divine Grace A. C. Bhaktivedanta Swami Prabhupāda";
  /** Publication location used for the English translation shown here. */
  readonly translationSource: string;
  readonly verification: Readonly<{
    status: "source_checked";
    checkedOn: "2026-08-09";
    passageUrl: `https://vedabase.io/${string}`;
    workAuthorshipUrl: `https://${string}`;
    translatorAttributionUrl: `https://${string}`;
    normalization: "none" | "editorial quotation wrappers omitted for standalone display";
    sourceCredit: "BBT International content used by VedaBase with permission; VedaBase owned by The Bhaktivedanta Archives Inc.";
    evidence: string;
  }>;
}

const TRANSLATOR = "Translation by His Divine Grace A. C. Bhaktivedanta Swami Prabhupāda" as const;
const SOURCE_CREDIT = "BBT International content used by VedaBase with permission; VedaBase owned by The Bhaktivedanta Archives Inc." as const;
const BRS_AUTHORSHIP_URL = "https://vedabase.io/en/library/nod/preface/" as const;
const CC_TRANSLATOR_URL = "https://vedabase.io/en/library/cc/adi/foreword/" as const;
const NOI_PREFACE_URL = "https://vedabase.io/en/library/noi/preface/" as const;

function freezePassage(passage: PremaPassage): PremaPassage {
  return Object.freeze({
    ...passage,
    verification: Object.freeze({ ...passage.verification }),
  });
}

/**
 * Frozen, source-checked candidates from Śrīla Rūpa Gosvāmī's literature.
 * Keeping the verification evidence beside every quotation makes later edits
 * reviewable and prevents a generic or generated loader quotation sneaking in.
 */
export const PREMA_PASSAGE_CANDIDATES: readonly PremaPassage[] = Object.freeze([
  freezePassage({
    id: "brs-1-3-1",
    text: "When devotional service is executed on the transcendental platform of pure goodness, it is like a sun-ray of love for Kṛṣṇa. At such a time, devotional service causes the heart to be softened by various tastes, and one is then situated in bhāva [emotion].",
    work: "Bhakti-rasāmṛta-sindhu",
    reference: "1.3.1",
    author: "Śrīla Rūpa Gosvāmī",
    translatorAttribution: TRANSLATOR,
    translationSource: "Śrī Caitanya-caritāmṛta, Madhya-līlā 23.5",
    verification: {
      status: "source_checked",
      checkedOn: "2026-08-09",
      passageUrl: "https://vedabase.io/en/library/cc/madhya/23/5/",
      workAuthorshipUrl: BRS_AUTHORSHIP_URL,
      translatorAttributionUrl: CC_TRANSLATOR_URL,
      normalization: "editorial quotation wrappers omitted for standalone display",
      sourceCredit: SOURCE_CREDIT,
      evidence: "The English wording matches the Translation; only its surrounding editorial quotation marks are omitted. The Purport identifies Bhakti-rasāmṛta-sindhu 1.3.1.",
    },
  }),
  freezePassage({
    id: "brs-1-4-1",
    text: "When that bhāva softens the heart completely, becomes endowed with a great feeling of possessiveness in relation to the Lord and becomes very much condensed and intensified, it is called prema [love of Godhead] by learned scholars.",
    work: "Bhakti-rasāmṛta-sindhu",
    reference: "1.4.1",
    author: "Śrīla Rūpa Gosvāmī",
    translatorAttribution: TRANSLATOR,
    translationSource: "Śrī Caitanya-caritāmṛta, Madhya-līlā 23.7",
    verification: {
      status: "source_checked",
      checkedOn: "2026-08-09",
      passageUrl: "https://vedabase.io/en/library/cc/madhya/23/7/",
      workAuthorshipUrl: BRS_AUTHORSHIP_URL,
      translatorAttributionUrl: CC_TRANSLATOR_URL,
      normalization: "editorial quotation wrappers omitted for standalone display",
      sourceCredit: SOURCE_CREDIT,
      evidence: "The English wording matches the Translation; only its opening editorial quotation marks are omitted because the source itself has no closing wrapper. The Purport identifies Bhakti-rasāmṛta-sindhu 1.4.1.",
    },
  }),
  freezePassage({
    id: "upadesamrta-8",
    text: "The essence of all advice is that one should utilize one’s full time – twenty-four hours a day – in nicely chanting and remembering the Lord’s divine name, transcendental form, qualities and eternal pastimes, thereby gradually engaging one’s tongue and mind. In this way one should reside in Vraja [Goloka Vṛndāvana-dhāma] and serve Kṛṣṇa under the guidance of devotees. One should follow in the footsteps of the Lord’s beloved devotees, who are deeply attached to His devotional service.",
    work: "Upadeśāmṛta",
    reference: "Text 8",
    author: "Śrīla Rūpa Gosvāmī",
    translatorAttribution: TRANSLATOR,
    translationSource: "The Nectar of Instruction, Text 8",
    verification: {
      status: "source_checked",
      checkedOn: "2026-08-09",
      passageUrl: "https://vedabase.io/en/library/noi/8/",
      workAuthorshipUrl: NOI_PREFACE_URL,
      translatorAttributionUrl: NOI_PREFACE_URL,
      normalization: "none",
      sourceCredit: SOURCE_CREDIT,
      evidence: "The Translation matches exactly, including punctuation. The signed book preface identifies Upadeśāmṛta as Śrīla Rūpa Gosvāmī's work.",
    },
  }),
  freezePassage({
    id: "upadesamrta-11",
    text: "Of the many objects of favored delight and of all the lovable damsels of Vraja-bhūmi, Śrīmatī Rādhārāṇī is certainly the most treasured object of Kṛṣṇa’s love. And, in every respect, Her divine kuṇḍa is described by great sages as similarly dear to Him. Undoubtedly Rādhā-kuṇḍa is very rarely attained even by the great devotees; therefore it is even more difficult for ordinary devotees to attain. If one simply bathes once within those holy waters, one’s pure love of Kṛṣṇa is fully aroused.",
    work: "Upadeśāmṛta",
    reference: "Text 11",
    author: "Śrīla Rūpa Gosvāmī",
    translatorAttribution: TRANSLATOR,
    translationSource: "The Nectar of Instruction, Text 11",
    verification: {
      status: "source_checked",
      checkedOn: "2026-08-09",
      passageUrl: "https://vedabase.io/en/library/noi/11/",
      workAuthorshipUrl: NOI_PREFACE_URL,
      translatorAttributionUrl: NOI_PREFACE_URL,
      normalization: "none",
      sourceCredit: SOURCE_CREDIT,
      evidence: "The Translation matches exactly, including punctuation. The signed book preface identifies Upadeśāmṛta as Śrīla Rūpa Gosvāmī's work.",
    },
  }),
]);

/** SHA-256 of JSON.stringify(PREMA_PASSAGE_CANDIDATES), pinned by tests. */
export const PREMA_PASSAGE_COLLECTION_SHA256 = "3d6951600d29601cb20c84f41c687502c421543dd0fa2c438556dd8fd90baff9";
