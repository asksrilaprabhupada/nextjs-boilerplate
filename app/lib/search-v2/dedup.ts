/**
 * dedup.ts — Real duplicates only.
 *
 * Two passages SOUNDING similar does not make them the same passage. Two
 * different paragraphs of one purport can answer two different parts of a
 * question, and the embedding-cosine stage that used to merge "near
 * duplicates" threw exactly such passages away. That stage is gone.
 *
 * Only three things may collapse now:
 *
 *   1. The exact same passage surfaced by different questions — that merge
 *      happens in fusion (one entry per passage_key, with every finding query
 *      remembered in queryCoverage) before this module ever runs.
 *   2. Two passages whose text is identical after tidying spaces, quotes and
 *      diacritics for comparison.
 *   3. A shorter passage whose words sit almost entirely (90% or more) inside
 *      a longer one from the same source and reference — overlapping chunks of
 *      one purport, in practice. The longer is kept.
 *
 * And the old never-merge rules still hold: a verse is never collapsed into its
 * purport, a letter never into anything else, letters to different recipients
 * never into each other. When a group does collapse, the alternates are kept so
 * the renderer can say "also appears in N places" rather than silently dropping
 * provenance.
 */
import type { FusedCandidate } from "@/app/lib/search-v2/fusion";

export interface AlternateSource {
  passageKey: string;
  sourceType: string;
  reference: string | null;
}

export interface DedupedCandidate extends FusedCandidate {
  /** Other places this same passage text appears, kept for disclosure. */
  alternates: AlternateSource[];
}

export interface DedupStats {
  input: number;
  exactCollapsed: number;
  /** Shorter passages absorbed into a longer same-source passage. */
  containedCollapsed: number;
  output: number;
}

export interface DedupResult {
  candidates: DedupedCandidate[];
  stats: DedupStats;
}

/**
 * Normalises passage text for equality testing only. Never used for display —
 * displayed text always comes from a fresh fetch of the source row.
 */
export function normalizeForHash(text: string): string {
  return (text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[^a-z0-9'"\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when two candidates must never be collapsed into one another,
 * regardless of how similar their text is.
 */
export function mustNotCollapse(a: FusedCandidate, b: FusedCandidate): boolean {
  const types = new Set([a.source_type, b.source_type]);

  // A verse and its purport are different layers, not duplicates.
  if (types.has("verse") && types.has("purport")) return true;

  // A letter carries a recipient and a date; a book instruction does not.
  // Collapsing one into the other turns correspondence into doctrine.
  if (types.has("letter") && types.size > 1) return true;

  // Two letters to different recipients are different acts of instruction.
  if (a.source_type === "letter" && b.source_type === "letter") {
    const ra = (a.recipient || "").trim().toLowerCase();
    const rb = (b.recipient || "").trim().toLowerCase();
    if (ra !== rb) return true;
  }

  return false;
}

/** Shingle length for containment. Long enough that shared vocabulary alone
 *  cannot fake containment; two different paragraphs of one purport share
 *  words, not eight-word runs. */
const SHINGLE_WORDS = 8;

/** Fraction of the shorter text's shingles that must appear verbatim in the longer. */
const CONTAINMENT_FRACTION = 0.9;

/** Texts shorter than this (normalised chars) are too small to judge containment. */
const MIN_CONTAINMENT_CHARS = 80;

/** Buckets bigger than this skip containment — O(n²) inside a bucket. */
const MAX_BUCKET = 50;

/**
 * True when at least 90% of the shorter text sits verbatim inside the longer.
 * Judged on contiguous word runs, not shared vocabulary.
 */
export function isContained(shortNorm: string, longNorm: string): boolean {
  if (!shortNorm || shortNorm.length < MIN_CONTAINMENT_CHARS) return false;
  if (longNorm.includes(shortNorm)) return true;
  const words = shortNorm.split(" ");
  if (words.length < SHINGLE_WORDS) return false;
  let hits = 0;
  let total = 0;
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i += SHINGLE_WORDS) {
    total += 1;
    if (longNorm.includes(words.slice(i, i + SHINGLE_WORDS).join(" "))) hits += 1;
  }
  return total > 0 && hits / total >= CONTAINMENT_FRACTION;
}

/**
 * Collapses duplicates, keeping the contextually complete representative of
 * each group — given two copies of the same text, the one carrying a reference
 * (and a recipient/date where the type has them) is the one a reader can
 * actually verify, so it wins even at a slightly lower fused score.
 */
export function dedupeCandidates(candidates: FusedCandidate[]): DedupResult {
  const input = candidates.length;
  let exactCollapsed = 0;
  let containedCollapsed = 0;

  // ── Stage 1: exact / normalised text ──
  const byHash = new Map<string, DedupedCandidate>();
  const ordered: DedupedCandidate[] = [];

  for (const c of candidates) {
    const hash = normalizeForHash(c.retrieval_text);
    if (!hash) {
      ordered.push({ ...c, alternates: [] });
      continue;
    }

    const seen = byHash.get(hash);
    if (seen && !mustNotCollapse(seen, c)) {
      const winner = preferComplete(seen, c);
      const loser = winner === seen ? c : seen;
      if (winner !== seen) {
        // Promote the better representative in place, keeping list position.
        Object.assign(seen, winner, { alternates: seen.alternates });
      }
      seen.alternates.push({
        passageKey: loser.passage_key,
        sourceType: loser.source_type,
        reference: loser.reference,
      });
      exactCollapsed += 1;
      continue;
    }

    const entry: DedupedCandidate = { ...c, alternates: [] };
    if (!seen) byHash.set(hash, entry);
    ordered.push(entry);
  }

  // ── Stage 2: containment, within same source_type + reference only ──
  // The genuine case is overlapping chunks of one purport. Comparing across
  // types or references is where "sounds alike" merges used to lose passages,
  // so the buckets are deliberately narrow.
  const buckets = new Map<string, DedupedCandidate[]>();
  for (const c of ordered) {
    const key = `${c.source_type}|${(c.reference || "").trim().toLowerCase()}`;
    const list = buckets.get(key) ?? [];
    list.push(c);
    buckets.set(key, list);
  }

  const absorbed = new Set<string>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > MAX_BUCKET) continue;
    const norms = bucket.map((c) => normalizeForHash(c.retrieval_text));
    for (let i = 0; i < bucket.length; i++) {
      if (absorbed.has(bucket[i].passage_key)) continue;
      for (let j = 0; j < bucket.length; j++) {
        if (i === j || absorbed.has(bucket[j].passage_key) || absorbed.has(bucket[i].passage_key)) continue;
        const [a, b] = [bucket[i], bucket[j]];
        if (mustNotCollapse(a, b)) continue;
        const [shortC, longC] = norms[i].length <= norms[j].length ? [i, j] : [j, i];
        if (isContained(norms[shortC], norms[longC])) {
          const keeper = bucket[longC];
          const dropped = bucket[shortC];
          keeper.alternates.push({
            passageKey: dropped.passage_key,
            sourceType: dropped.source_type,
            reference: dropped.reference,
          });
          absorbed.add(dropped.passage_key);
          containedCollapsed += 1;
        }
      }
    }
  }

  const kept = ordered.filter((c) => !absorbed.has(c.passage_key));

  return {
    candidates: kept,
    stats: { input, exactCollapsed, containedCollapsed, output: kept.length },
  };
}

/**
 * Between two copies of the same text, prefer the one a reader can verify:
 * a reference beats no reference, then the higher fused score wins.
 */
function preferComplete(a: DedupedCandidate | FusedCandidate, b: FusedCandidate) {
  const aRef = Boolean((a.reference || "").trim());
  const bRef = Boolean((b.reference || "").trim());
  if (aRef !== bRef) return aRef ? a : b;
  return a.fusedScore >= b.fusedScore ? a : b;
}
