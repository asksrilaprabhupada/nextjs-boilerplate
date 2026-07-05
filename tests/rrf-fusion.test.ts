/**
 * rrf-fusion.test.ts — fuseRankedLists (Reciprocal Rank Fusion) unit tests
 *
 * Covers: cross-list score accumulation and ordering, tie behaviour, the cap,
 * and the canonical-row rule (first list containing an id supplies its data —
 * the original query's enriched list must win).
 */
import { describe, it, expect } from "vitest";
import { fuseRankedLists } from "@/app/lib/16-multi-query";

type Row = { id: string; text?: string; similarity?: number; matchedChunkText?: string };

const row = (id: string, extra: Partial<Row> = {}): Row => ({ id, ...extra });

describe("fuseRankedLists", () => {
  it("ranks an item found in many lists above single-list items at similar ranks", () => {
    const a = [row("common"), row("onlyA")];
    const b = [row("common"), row("onlyB")];
    const c = [row("common"), row("onlyC")];
    const fused = fuseRankedLists([a, b, c]);
    expect(fused[0].id).toBe("common");
    // 3 lists × 1/(60+0) vs 1/(60+1)
    expect(fused[0].score).toBeCloseTo(3 / 60, 10);
    expect(fused[1].score).toBeCloseTo(1 / 61, 10);
  });

  it("weights by rank within each list (rrf = Σ 1/(k + rank))", () => {
    const a = [row("x"), row("y")];
    const b = [row("y"), row("x")];
    const fused = fuseRankedLists([a, b]);
    // x: 1/60 + 1/61 == y: 1/61 + 1/60 — a genuine tie; both scores equal
    expect(fused[0].score).toBeCloseTo(fused[1].score, 12);
    expect(new Set(fused.map(f => f.id))).toEqual(new Set(["x", "y"]));
  });

  it("respects a custom k", () => {
    const fused = fuseRankedLists([[row("a")]], 10);
    expect(fused[0].score).toBeCloseTo(1 / 10, 10);
  });

  it("caps the fused list length", () => {
    const list = Array.from({ length: 50 }, (_, i) => row(`id${i}`));
    const fused = fuseRankedLists([list], 60, 7);
    expect(fused).toHaveLength(7);
    expect(fused[0].id).toBe("id0");
  });

  it("takes the canonical row from the FIRST list containing the id (original wins)", () => {
    const original = [row("v1", { similarity: 0.91, matchedChunkText: "the matched purport section" })];
    const variant = [row("v1", { similarity: 0.42 }), row("v2", { text: "variant-only hit" })];
    const fused = fuseRankedLists([original, variant]);
    const v1 = fused.find(f => f.id === "v1")!;
    expect(v1.similarity).toBe(0.91);
    expect(v1.matchedChunkText).toBe("the matched purport section");
    // Variant-only items still enter the pool with their own data
    expect(fused.find(f => f.id === "v2")?.text).toBe("variant-only hit");
  });

  it("replaces per-list scores with the fused score", () => {
    const withOldScore = [{ id: "a", score: 999 } as Row & { score: number }];
    const fused = fuseRankedLists([withOldScore]);
    expect(fused[0].score).toBeCloseTo(1 / 60, 10);
  });

  it("handles empty input and skips malformed items", () => {
    expect(fuseRankedLists([])).toEqual([]);
    expect(fuseRankedLists([[]])).toEqual([]);
    const fused = fuseRankedLists([[row("ok"), { id: "" } as Row, undefined as unknown as Row]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].id).toBe("ok");
  });
});
