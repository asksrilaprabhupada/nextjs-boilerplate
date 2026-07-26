/**
 * search-v2-article.test.ts — Phase C cover: re-fetch, plan validation, render.
 *
 * The re-fetch tests are the hard stop the brief names: "Do not ship Phase C
 * until this test passes." They assert the ONLY acceptable behaviour when a
 * passage cannot be verified — it disappears. Never repaired, never substituted,
 * never rendered from the stale copy.
 */
import { describe, it, expect } from "vitest";
import { refetchAndVerify, isRenderable, type VerifiedPassage } from "@/app/lib/search-v2/refetch";
import { articleRejections, ArticlePlanSchema, DISCLOSURE, type ArticlePlan } from "@/app/lib/search-v2/article-plan";
import { renderArticle } from "@/app/lib/search-v2/render";
import { articleToHtml } from "@/app/lib/search-v2/adapt";
import type { SelectedPassage } from "@/app/lib/search-v2/select";

// ─── fakes ───────────────────────────────────────────────────

function selected(passageKey: string, text: string, over: Record<string, unknown> = {}): SelectedPassage {
  return {
    candidate: {
      passage_key: passageKey,
      source_type: passageKey.split(":")[0],
      row_id: passageKey.split(":")[1],
      retrieval_text: text,
      reference: "ref",
      speaker: null,
      recipient: null,
      occurred_on: null,
      location: null,
      matched_query_ids: [],
      channel_ranks: [],
      channel_scores: {},
      tag_matches: 0,
      fusedScore: 1,
      contributions: [],
      queryCoverage: [],
      alternates: [],
      ...over,
    },
    reasons: [],
    contextRequirements: [],
    rerankPosition: 0,
  } as unknown as SelectedPassage;
}

function fakeDb(rowsByTable: Record<string, Record<string, unknown>[]>, failTable?: string) {
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      return {
        select() {
          return {
            in(_col: string, ids: string[]) {
              if (failTable === table) {
                return Promise.resolve({ data: null, error: { code: "57014" } });
              }
              const rows = (rowsByTable[table] || []).filter(r => ids.includes(String(r.id)));
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
  };
}

const ctx = { requestId: "req_test" };

// ─── C3: exact re-fetch, the hard stop ───────────────────────

describe("exact re-fetch (hard stop)", () => {
  it("verifies a passage whose stored text matches", async () => {
    const db = fakeDb({
      verses: [{ id: "v1", scripture: "BG", verse_number: "18.66", translation: "Abandon all varieties of religion.", vedabase_url: "u" }],
    });
    const out = await refetchAndVerify(db as never, [selected("verse:v1", "Abandon all varieties of religion.")], ctx);
    expect(out.verified).toHaveLength(1);
    expect(out.dropped).toHaveLength(0);
    expect(out.verified[0].text).toBe("Abandon all varieties of religion.");
    expect(out.verified[0].reference).toBe("BG 18.66");
  });

  it("DROPS a passage whose stored text no longer matches", async () => {
    const db = fakeDb({ verses: [{ id: "v1", translation: "Completely different text now." }] });
    const out = await refetchAndVerify(db as never, [selected("verse:v1", "Abandon all varieties of religion.")], ctx);
    expect(out.verified).toHaveLength(0);
    expect(out.dropped[0].reason).toBe("text_mismatch");
  });

  it("DROPS a passage whose row has vanished", async () => {
    const db = fakeDb({ verses: [] });
    const out = await refetchAndVerify(db as never, [selected("verse:v1", "anything")], ctx);
    expect(out.dropped[0].reason).toBe("row_not_found");
  });

  it("DROPS everything in a namespace whose verification read failed", async () => {
    const db = fakeDb({ verses: [{ id: "v1", translation: "x" }] }, "verses");
    const out = await refetchAndVerify(db as never, [selected("verse:v1", "x")], ctx);
    expect(out.verified).toHaveLength(0);
    expect(out.dropped[0].reason).toBe("fetch_failed");
  });

  it("rejects a passage_key with an unknown namespace", async () => {
    const db = fakeDb({});
    const out = await refetchAndVerify(db as never, [selected("wikipedia:v1", "x")], ctx);
    expect(out.dropped[0].reason).toBe("unknown_namespace");
  });

  it("reads the table the namespace names, so a key cannot resolve cross-table", async () => {
    // A key claiming to be a verse must be read from `verses`, even though a
    // letter row shares the id.
    const db = fakeDb({
      verses: [],
      letter_paragraphs: [{ id: "shared", body_text: "letter text", recipient: "R", date: "1970-01-01" }],
    });
    const out = await refetchAndVerify(db as never, [selected("verse:shared", "letter text")], ctx);
    expect(out.verified).toHaveLength(0);
    expect(out.dropped[0].reason).toBe("row_not_found");
  });

  it("takes speaker, recipient and date from the fresh row only", async () => {
    const db = fakeDb({
      letter_paragraphs: [{ id: "l1", body_text: "Please chant.", recipient: "Rayarama", date: "1968-02-01", title: "Letter to Rayarama" }],
    });
    // The stale candidate claims a DIFFERENT recipient; the fresh row must win.
    const out = await refetchAndVerify(
      db as never,
      [selected("letter:l1", "Please chant.", { recipient: "Somebody Else", occurred_on: "1999-01-01" })],
      ctx,
    );
    expect(out.verified[0].recipient).toBe("Rayarama");
    expect(out.verified[0].date).toBe("1968-02-01");
  });

  it("refuses to render a letter lacking a verified recipient or date", () => {
    const base = { sourceType: "letter", recipient: null, date: null } as unknown as VerifiedPassage;
    expect(isRenderable(base)).toBe(false);
    expect(isRenderable({ ...base, recipient: "R", date: "1970-01-01" })).toBe(true);
  });
});

// ─── C2: article plan validation ─────────────────────────────

describe("article plan validation", () => {
  const passages = [
    { passageKey: "verse:1", sourceType: "verse", reference: "BG 6.6", date: null, recipient: null, text: "t" },
    { passageKey: "purport:1", sourceType: "purport", reference: "BG 6.6", date: null, recipient: null, text: "p" },
  ] as unknown as VerifiedPassage[];

  const base: ArticlePlan = {
    schema_version: "article-plan-v1",
    article_type: "guided_study",
    title: "Controlling the Mind: Practice and Detachment",
    opening: { kind: "direct_source", passage_id: "verse:1" },
    direct_answer_passage_ids: ["verse:1"],
    sections: [{ heading_key: "foundation", short_subject: "the mind", passage_ids: ["verse:1"], transition_type: "none" }],
    closing: { kind: "none", passage_ids: [] },
    disclosure: DISCLOSURE,
  };

  const check = (p: ArticlePlan) =>
    articleRejections({ plan: p, passages, maxFinalPassages: 8, question: "how do I control my mind" }).join(" ");

  it("accepts a well-formed plan", () => {
    expect(check(base)).toBe("");
  });

  it("rejects an id that was never supplied — the invented-citation guard", () => {
    expect(check({ ...base, sections: [{ ...base.sections[0], passage_ids: ["verse:999"] }] })).toMatch(/never supplied/);
  });

  it("rejects more passages than the mode permits", () => {
    const many = articleRejections({
      plan: { ...base, sections: [{ ...base.sections[0], passage_ids: ["verse:1", "purport:1"] }] },
      passages,
      maxFinalPassages: 1,
      question: "q",
    }).join(" ");
    expect(many).toMatch(/mode permits/);
  });

  it("rejects a promotional or unsupported title", () => {
    expect(check({ ...base, title: "The Secret Ancient Formula That Will Transform Your Mind" })).toMatch(/unsupported or promotional/);
  });

  it("rejects a section subject written as prose", () => {
    expect(check({ ...base, sections: [{ ...base.sections[0], short_subject: "the mind is restless" }] })).toMatch(/reads as prose/);
  });

  it("rejects chronology claimed without dates", () => {
    expect(check({ ...base, article_type: "chronological_development" })).toMatch(/fewer than two passages carry dates/);
  });

  it("rejects an evidence-insufficient plan that asserts an answer", () => {
    expect(check({ ...base, article_type: "evidence_insufficient" })).toMatch(/asserts a direct answer/);
  });

  it("rejects a letter without verified recipient and date", () => {
    const lp = [{ passageKey: "letter:1", sourceType: "letter", reference: "L", date: null, recipient: null, text: "t" }] as unknown as VerifiedPassage[];
    const out = articleRejections({
      plan: { ...base, opening: { kind: "direct_source", passage_id: "letter:1" }, direct_answer_passage_ids: [], sections: [{ ...base.sections[0], passage_ids: ["letter:1"] }] },
      passages: lp,
      maxFinalPassages: 8,
      question: "q",
    }).join(" ");
    expect(out).toMatch(/lacks verified recipient\/date/);
  });

  it("pins the disclosure string so a plan cannot reword it", () => {
    expect(ArticlePlanSchema.safeParse({ ...base, disclosure: "Written by AI." }).success).toBe(false);
  });
});

// ─── C4: deterministic renderer ──────────────────────────────

describe("deterministic renderer", () => {
  const verse = {
    passageKey: "verse:1", sourceType: "verse", rowId: "1",
    text: "For him who has conquered the mind, the mind is the best of friends.",
    reference: "BG 6.6", speaker: null, recipient: null, date: null, location: null,
    vedabaseUrl: "https://vedabase.io/en/library/bg/6/6/",
    sanskrit: null, transliteration: null, synonyms: null, purport: null,
    selection: { candidate: { alternates: [] } },
  } as unknown as VerifiedPassage;

  const letter = {
    ...verse, passageKey: "letter:1", sourceType: "letter", rowId: "2",
    text: "Please chant sixteen rounds.", reference: "Letter to Rayarama",
    recipient: "Rayarama", date: "1968-02-01", vedabaseUrl: null,
  } as unknown as VerifiedPassage;

  it("renders exact stored text, unedited", () => {
    const a = renderArticle({ question: "q", passages: [verse], plan: null, mode: "quick" });
    expect(a.sections[0].blocks[0].text).toBe(verse.text);
  });

  it("labels a letter as specific correspondence with recipient and year", () => {
    const a = renderArticle({ question: "q", passages: [letter], plan: null, mode: "guided" });
    const block = a.sections[0].blocks[0];
    expect(block.contextNotice).toBe("Specific correspondence — Letter to Rayarama, 1968");
    expect(block.contextNoticeKind).toBe("letter");
  });

  it("always carries the disclosure", () => {
    const a = renderArticle({ question: "q", passages: [verse], plan: null, mode: "quick" });
    expect(a.disclosure).toBe(DISCLOSURE);
    expect(articleToHtml(a)).toContain(DISCLOSURE);
  });

  it("renders without a plan and marks itself unplanned", () => {
    const a = renderArticle({ question: "how do I steady the mind", passages: [verse], plan: null, mode: "quick" });
    expect(a.planned).toBe(false);
    expect(a.title.length).toBeGreaterThan(0);
    expect(a.sections[0].blocks).toHaveLength(1);
  });

  it("omits the source map in Quick Answer and includes it in Guided Study", () => {
    expect(renderArticle({ question: "q", passages: [verse], plan: null, mode: "quick" }).sourceMap).toBeNull();
    expect(renderArticle({ question: "q", passages: [verse], plan: null, mode: "guided" }).sourceMap).toContain("Drawn from");
  });

  it("never drops a passage the plan failed to place", () => {
    const plan: ArticlePlan = {
      schema_version: "article-plan-v1", article_type: "guided_study", title: "Title",
      opening: { kind: "direct_source", passage_id: "verse:1" },
      direct_answer_passage_ids: [],
      sections: [{ heading_key: "foundation", short_subject: "", passage_ids: ["verse:1"], transition_type: "none" }],
      closing: { kind: "none", passage_ids: [] }, disclosure: DISCLOSURE,
    };
    const a = renderArticle({ question: "q", passages: [verse, letter], plan, mode: "guided" });
    const keys = a.sections.flatMap(s => s.blocks.map(b => b.passageKey));
    expect(keys).toContain("letter:1");
  });

  it("escapes passage text so stored punctuation cannot inject markup", () => {
    const nasty = { ...verse, text: '<script>alert("x")</script>' } as unknown as VerifiedPassage;
    const html = articleToHtml(renderArticle({ question: "q", passages: [nasty], plan: null, mode: "quick" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says so plainly when there is no evidence, rather than assembling one", () => {
    const a = renderArticle({ question: "q", passages: [], plan: null, mode: "guided" });
    expect(a.evidenceInsufficient).toBe(true);
    expect(articleToHtml(a)).toMatch(/No passage in the library directly answers/);
  });
});
