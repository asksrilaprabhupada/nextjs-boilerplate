/**
 * page.tsx — Verse Detail Page (server-rendered)
 *
 * Fetches a single verse by id server-side (fast first paint, no fetch-on-mount
 * flash, SEO-indexable) and computes its previous/next siblings within the same
 * chapter. Delegates all interaction (layer toggles, swipe, cross-ref previews)
 * to the client child VerseView.
 */
import Link from "next/link";
import { getSupabaseAdmin } from "@/app/lib/01-supabase";
import VerseView, { type VerseData } from "@/app/components/verse/01-verse-view";

export const dynamic = "force-dynamic";

const scriptureNames: Record<string, string> = {
  BG: "BHAGAVAD GĪTĀ AS IT IS",
  SB: "ŚRĪMAD BHĀGAVATAM",
  CC: "ŚRĪ CAITANYA CARITĀMṚTA",
};

const leadingInt = (s: string) => parseInt((String(s).match(/\d+/) || ["0"])[0], 10);

export default async function VerseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();

  const { data: verse } = await supabase
    .from("verses")
    .select("*, chapters(chapter_number, canto_or_division, chapter_title, scripture)")
    .eq("id", id)
    .single();

  if (!verse) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <p className="font-display" style={{ fontSize: "1.2rem", color: "var(--ink-muted)" }}>Verse not found</p>
        <Link href="/" className="font-body" style={{ fontSize: 14, color: "var(--accent-strong)", textDecoration: "none", fontWeight: 500 }}>← Back to search</Link>
      </div>
    );
  }

  // Previous / next within the same chapter, ordered by the numeric verse number.
  let prevId: string | null = null;
  let nextId: string | null = null;
  if (verse.chapter_id) {
    const { data: siblings } = await supabase.from("verses").select("id, verse_number").eq("chapter_id", verse.chapter_id);
    if (siblings && siblings.length > 1) {
      const sorted = [...siblings].sort((a, b) => leadingInt(a.verse_number) - leadingInt(b.verse_number));
      const idx = sorted.findIndex((v) => v.id === id);
      if (idx > 0) prevId = sorted[idx - 1].id;
      if (idx >= 0 && idx < sorted.length - 1) nextId = sorted[idx + 1].id;
    }
  }

  const scriptureName = scriptureNames[verse.scripture] || verse.scripture;

  return <VerseView verse={verse as VerseData} prevId={prevId} nextId={nextId} scriptureName={scriptureName} />;
}
