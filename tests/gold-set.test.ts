/**
 * gold-set.test.ts — Integrity of the evaluation set itself.
 *
 * A gold set with malformed ids, duplicate question ids, or silent category
 * gaps produces metrics that look authoritative and mean nothing. These checks
 * are cheap and run in CI so the set cannot rot unnoticed.
 *
 * They deliberately do NOT assert that the labels are correct — that requires a
 * devotee's judgement, which is why every unreviewed row carries
 * `needs_human_review: true` and why the harness refuses to score them.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface GoldQuestion {
  id: string;
  question: string;
  category: string;
  must_find_passage_ids: string[];
  relevant_passages: { passage_id: string; grade: number }[];
  unacceptable_passage_ids: string[];
  context_requirements: string[];
  direct_answer_exists: boolean;
  needs_human_review: boolean;
}

interface GoldSet {
  schema_version: string;
  corpus_version: string;
  categories: string[];
  questions: GoldQuestion[];
}

interface RequiredMetadata {
  source_type?: string;
  recipient_required?: boolean;
  recipient_contains?: string;
  occurred_on_required?: boolean;
  occurred_year?: number;
  location_contains?: string;
  reference_contains?: string;
}

interface SuggestedLabel {
  question_id: string;
  status: "suggested_pending_owner_review";
  evaluation_kind: "passage_ids" | "metadata" | "manual";
  candidate_passage_ids: string[];
  required_metadata: RequiredMetadata[];
  unacceptable_passage_ids: string[];
  notes: string;
}

interface SupplementalCase extends Omit<SuggestedLabel, "question_id"> {
  id: string;
  question: string;
}

interface SuggestionSet {
  schema_version: string;
  gold_set_schema_version: string;
  gold_set_fingerprint_sha256: string;
  corpus_version: string;
  suggestions: SuggestedLabel[];
  supplemental_cases: SupplementalCase[];
}

const gold = JSON.parse(
  readFileSync(join(process.cwd(), "tests/gold/gold-set-v1.json"), "utf8"),
) as GoldSet;
const suggestions = JSON.parse(
  readFileSync(join(process.cwd(), "tests/gold/gold-set-v1-suggestions.json"), "utf8"),
) as SuggestionSet;

const PASSAGE_KEY_RE = /^(verse|purport|book|lecture|letter):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("gold set", () => {
  it("contains exactly the fixed 65 questions in order", () => {
    expect(gold.schema_version).toBe("gold-set-v1");
    expect(gold.questions).toHaveLength(65);
    expect(gold.questions.map((q) => q.id)).toEqual(
      Array.from({ length: 65 }, (_, index) => `q${String(index + 1).padStart(3, "0")}`),
    );
  });

  it("does not mislabel the 41 pending rows as reviewed", () => {
    expect(gold.questions.filter((q) => !q.needs_human_review)).toHaveLength(24);
    expect(gold.questions.filter((q) => q.needs_human_review)).toHaveLength(41);
  });

  it("has unique question ids", () => {
    const ids = gold.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every declared category", () => {
    const used = new Set(gold.questions.map((q) => q.category));
    const missing = gold.categories.filter((c) => !used.has(c));
    expect(missing, `categories with no questions: ${missing.join(", ")}`).toEqual([]);
  });

  it("uses only declared categories", () => {
    const declared = new Set(gold.categories);
    const undeclared = [...new Set(gold.questions.map((q) => q.category))].filter((c) => !declared.has(c));
    expect(undeclared).toEqual([]);
  });

  it("uses well-formed namespaced passage keys everywhere", () => {
    for (const q of gold.questions) {
      for (const id of [...q.must_find_passage_ids, ...q.unacceptable_passage_ids]) {
        expect(PASSAGE_KEY_RE.test(id), `${q.id}: malformed passage key "${id}"`).toBe(true);
      }
      for (const r of q.relevant_passages) {
        expect(PASSAGE_KEY_RE.test(r.passage_id), `${q.id}: malformed passage key "${r.passage_id}"`).toBe(true);
        expect(r.grade).toBeGreaterThanOrEqual(0);
        expect(r.grade).toBeLessThanOrEqual(3);
        expect(Number.isInteger(r.grade)).toBe(true);
      }
    }
  });

  it("keeps authoritative positive and unacceptable labels unique and disjoint", () => {
    for (const q of gold.questions) {
      const positive = [
        ...q.must_find_passage_ids,
        ...q.relevant_passages.map((passage) => passage.passage_id),
      ];
      expect(new Set(q.must_find_passage_ids).size, `${q.id}: duplicate must-find id`)
        .toBe(q.must_find_passage_ids.length);
      expect(new Set(q.unacceptable_passage_ids).size, `${q.id}: duplicate unacceptable id`)
        .toBe(q.unacceptable_passage_ids.length);
      expect(q.unacceptable_passage_ids.filter((id) => positive.includes(id)), `${q.id}: positive/unacceptable overlap`)
        .toEqual([]);
    }
  });

  it("marks a question with unverified labels as needing review", () => {
    // Anchored questions carry a verified must-find id; anything without one is
    // an opinion until a human confirms it.
    for (const q of gold.questions) {
      if (q.must_find_passage_ids.length === 0 && q.direct_answer_exists) {
        expect(q.needs_human_review, `${q.id} has no verified anchor but is not flagged`).toBe(true);
      }
    }
  });

  it("expects evidence_insufficient for out-of-domain questions", () => {
    for (const q of gold.questions.filter((x) => x.category === "no_direct_corpus_answer")) {
      expect(q.direct_answer_exists).toBe(false);
      expect(q.context_requirements.join(" ")).toMatch(/evidence_insufficient/);
    }
  });

  it("requires recipient and date context on every letter question", () => {
    for (const q of gold.questions.filter((x) => x.category === "letter_specific" || x.category === "recipient_date")) {
      const req = q.context_requirements.join(" ");
      expect(req, `${q.id} must require recipient context`).toMatch(/recipient/);
      expect(req, `${q.id} must require date context`).toMatch(/date/);
    }
  });

  it("has at least one anchored question in the exact-reference categories", () => {
    const anchored = gold.questions.filter(
      (q) => q.category === "exact_verse" && q.must_find_passage_ids.length > 0,
    );
    expect(anchored.length).toBeGreaterThanOrEqual(5);
  });
});

describe("provisional owner-review suggestions", () => {
  it("is tied to the exact gold file and corpus snapshot", () => {
    const fingerprint = createHash("sha256").update(JSON.stringify(gold)).digest("hex");
    expect(suggestions.schema_version).toBe("gold-set-suggestions-v1");
    expect(suggestions.gold_set_schema_version).toBe(gold.schema_version);
    expect(suggestions.corpus_version).toBe(gold.corpus_version);
    expect(suggestions.gold_set_fingerprint_sha256).toBe(fingerprint);
  });

  it("covers every pending question exactly once and no reviewed question", () => {
    const pendingIds = gold.questions.filter((q) => q.needs_human_review).map((q) => q.id).sort();
    const suggestionIds = suggestions.suggestions.map((suggestion) => suggestion.question_id).sort();
    expect(new Set(suggestionIds).size).toBe(suggestionIds.length);
    expect(suggestionIds).toEqual(pendingIds);
  });

  it("keeps provisional candidates valid without promoting them to gold", () => {
    const questionById = new Map(gold.questions.map((question) => [question.id, question]));
    for (const suggestion of suggestions.suggestions) {
      const question = questionById.get(suggestion.question_id)!;
      expect(question.needs_human_review).toBe(true);
      expect(question.must_find_passage_ids, `${question.id}: authoritative labels must stay empty`).toEqual([]);
      expect(question.relevant_passages, `${question.id}: authoritative labels must stay empty`).toEqual([]);
      expect(question.unacceptable_passage_ids, `${question.id}: authoritative labels must stay empty`).toEqual([]);
      expect(suggestion.status).toBe("suggested_pending_owner_review");
      expect(["passage_ids", "metadata", "manual"]).toContain(suggestion.evaluation_kind);
      expect(suggestion.notes.trim().length).toBeGreaterThan(0);
      expect(suggestion.candidate_passage_ids.length, `${question.id}: too many provisional candidates`)
        .toBeLessThanOrEqual(3);
      expect(new Set(suggestion.candidate_passage_ids).size).toBe(suggestion.candidate_passage_ids.length);
      expect(new Set(suggestion.unacceptable_passage_ids).size).toBe(suggestion.unacceptable_passage_ids.length);
      for (const passageId of [...suggestion.candidate_passage_ids, ...suggestion.unacceptable_passage_ids]) {
        expect(PASSAGE_KEY_RE.test(passageId), `${question.id}: malformed provisional passage key`).toBe(true);
      }
      expect(
        suggestion.unacceptable_passage_ids.filter((id) => suggestion.candidate_passage_ids.includes(id)),
        `${question.id}: provisional positive/unacceptable overlap`,
      ).toEqual([]);

      if (suggestion.evaluation_kind === "passage_ids") {
        expect(suggestion.candidate_passage_ids.length, `${question.id}: passage-id evaluation needs candidates`)
          .toBeGreaterThan(0);
      } else if (suggestion.evaluation_kind === "metadata") {
        expect(suggestion.required_metadata.length, `${question.id}: metadata evaluation needs a rule`)
          .toBeGreaterThan(0);
        for (const rule of suggestion.required_metadata) {
          expect(Object.values(rule).some((value) => value !== undefined && value !== ""), `${question.id}: empty metadata rule`)
            .toBe(true);
        }
      } else {
        expect(suggestion.required_metadata).toEqual([]);
      }
    }

    expect(suggestions.suggestions.find((item) => item.question_id === "q041")?.required_metadata[0])
      .toMatchObject({ recipient_required: true, occurred_year: 1970, location_contains: "Los Angeles" });
    expect(suggestions.suggestions.find((item) => item.question_id === "q042")?.required_metadata[0])
      .toMatchObject({ recipient_contains: "Rayarama", occurred_on_required: true });
  });

  it("keeps Śrāddha explicit as a separate proposed difficult case", () => {
    expect(gold.questions.some((question) => /(?:śrāddha|sraddha|shraddha)/iu.test(question.question)))
      .toBe(false);
    expect(suggestions.supplemental_cases).toHaveLength(1);
    const supplemental = suggestions.supplemental_cases[0];
    expect(supplemental.id).toBe("supplemental-sraddha-001");
    expect(supplemental.question).toMatch(/śrāddha/iu);
    expect(supplemental.status).toBe("suggested_pending_owner_review");
    expect(supplemental.candidate_passage_ids.length).toBeGreaterThan(0);
    expect(supplemental.candidate_passage_ids.length).toBeLessThanOrEqual(3);
    expect(new Set(supplemental.candidate_passage_ids).size)
      .toBe(supplemental.candidate_passage_ids.length);
    expect(new Set(supplemental.unacceptable_passage_ids).size)
      .toBe(supplemental.unacceptable_passage_ids.length);
    expect(supplemental.unacceptable_passage_ids.filter((id) =>
      supplemental.candidate_passage_ids.includes(id))).toEqual([]);
    for (const passageId of [
      ...supplemental.candidate_passage_ids,
      ...supplemental.unacceptable_passage_ids,
    ]) {
      expect(PASSAGE_KEY_RE.test(passageId)).toBe(true);
    }
  });
});
