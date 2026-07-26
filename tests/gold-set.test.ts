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
import { readFileSync } from "fs";
import { join } from "path";

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
  categories: string[];
  questions: GoldQuestion[];
}

const gold = JSON.parse(
  readFileSync(join(process.cwd(), "tests/gold/gold-set-v1.json"), "utf8"),
) as GoldSet;

const PASSAGE_KEY_RE = /^(verse|purport|book|lecture|letter):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("gold set", () => {
  it("meets the brief's minimum of 50 reviewed questions", () => {
    expect(gold.questions.length).toBeGreaterThanOrEqual(50);
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
      }
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
