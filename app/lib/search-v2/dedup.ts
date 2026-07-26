/**
 * dedup.ts — Two-stage duplicate collapse.
 *
 * Stage 1: exact / normalised text hashing.
 * Stage 2: near-duplicate comparison by embedding cosine.
 *
 * The corpus genuinely repeats itself — Śrīla Prabhupāda quotes the same verse
 * across a book, a lecture and a letter — and showing the same passage three
 * times wastes a devotee's attention. But collapsing is destructive, so the
 * rules about what must NEVER merge matter more than the similarity threshold:
 *
 *   - a verse is never collapsed into its own purport (different layers of the
 *     same teaching, and the reader is entitled to both),
 *   - a personal letter is never collapsed into a general book instruction
 *     (recipient-specific guidance is not universal instruction),
 *   - two different teachings are never merged because their embeddings are
 *     close. Similar wording is not the same claim.
 *
 * When a group does collapse, the alternates are preserved so the renderer can
 * offer "also appears in N places" rather than silently dropping provenance.
 */
import { SEARCH_V2_CONFIG } from "@/app/lib/search-v2/config";
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
  nearCollapsed: number;
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

function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Collapses duplicates, keeping the highest-ranked contextually complete
 * representative of each group.
 *
 * "Contextually complete" is why this does not simply keep the top-scoring
 * candidate: given two copies of the same text, the one carrying a reference
 * (and a recipient/date where the type has them) is the one a reader can
 * actually verify, so it wins even at a slightly lower fused score.
 *
 * @param embeddings optional passage_key → vector map. Absent, only stage 1
 *                   runs — near-duplicate collapse is skipped rather than
 *                   approximated, because a wrong merge is unrecoverable.
 */
export function dedupeCandidates(
  candidates: FusedCandidate[],
  embeddings?: Map<string, number[]>,
  threshold: number = SEARCH_V2_CONFIG.duplicateCosine,
): DedupResult {
  const input = candidates.length;
  let exactCollapsed = 0;
  let nearCollapsed = 0;

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

  if (!embeddings || embeddings.size === 0) {
    return {
      candidates: ordered,
      stats: { input, exactCollapsed, nearCollapsed, output: ordered.length },
    };
  }

  // ── Stage 2: near-duplicate by embedding ──
  const kept: DedupedCandidate[] = [];
  for (const c of ordered) {
    const vec = embeddings.get(c.passage_key);
    let mergedInto: DedupedCandidate | null = null;

    if (vec) {
      for (const k of kept) {
        if (mustNotCollapse(k, c)) continue;
        const kv = embeddings.get(k.passage_key);
        if (!kv) continue;
        if (cosine(vec, kv) >= threshold) {
          mergedInto = k;
          break;
        }
      }
    }

    if (mergedInto) {
      mergedInto.alternates.push({
        passageKey: c.passage_key,
        sourceType: c.source_type,
        reference: c.reference,
      });
      nearCollapsed += 1;
    } else {
      kept.push(c);
    }
  }

  return {
    candidates: kept,
    stats: { input, exactCollapsed, nearCollapsed, output: kept.length },
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
