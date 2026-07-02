/**
 * 14-verse-speaker.ts — Story speaker for verses, from uvāca markers
 *
 * Source of truth: the `<name> uvāca` / `<names> ūcuḥ` ("…said") markers that
 * open the `transliteration` field of a verse (e.g. "śrī-śuka uvāca",
 * "arjuna uvāca", "rājovāca"). Speakers are NEVER guessed:
 *   - Bhagavad-gītā: the dialogue's default speaker is Kṛṣṇa addressing
 *     Arjuna; an uvāca marker switches it (Arjuna, Sañjaya, Dhṛtarāṣṭra).
 *   - Śrīmad-Bhāgavatam: the most recent uvāca speaker is carried forward
 *     WITHIN a chapter; verses before the chapter's first marker, or verses
 *     where the speaker changes mid-verse (multi-śloka ranges), get NO
 *     speaker. Nested narration makes carry-forward fallible — when not
 *     confident, show nothing.
 *   - "śrī-bhagavān uvāca" resolves to Kṛṣṇa only inside the Bhagavad-gītā;
 *     in the Bhāgavatam it is displayed as "the Supreme Lord" (in Canto 3,
 *     for example, the speaker is Lord Kapila).
 *
 * Pure module (no Supabase imports); the search route and the verse page feed
 * it chapter verse lists and attach the results to hits.
 */

export interface SpeakerState {
  speaker: string;
  /** Addressee — only for the Bhagavad-gītā dialogue, where it is explicit. */
  speakerTo?: string;
}

interface UvacaParse {
  /** True when the line IS an uvāca/ūcuḥ marker. */
  found: boolean;
  /** Display name; null when the marker names no identifiable speaker. */
  display: string | null;
}

/** Explicit marker → display map (markers normalized: lowercased, śrī- stripped). */
const SPEAKER_NAMES: Record<string, string> = {
  "śuka": "Śukadeva Gosvāmī",
  "bādarāyaṇir": "Śukadeva Gosvāmī",
  "bhagavān": "the Supreme Lord",
  "maitreya": "Maitreya Ṛṣi",
  "sūta": "Sūta Gosvāmī",
  "nārada": "Nārada Muni",
  "uddhava": "Uddhava",
  "arjuna": "Arjuna",
  "vidura": "Vidura",
  "prahrāda": "Prahlāda Mahārāja",
  "prahlāda": "Prahlāda Mahārāja",
  "ṛṣir": "the sage",
  "sañjaya": "Sañjaya",
  "śaunaka": "Śaunaka Ṛṣi",
  "vasudeva": "Vasudeva",
  "yudhiṣṭhira": "Yudhiṣṭhira Mahārāja",
  "devahūtir": "Devahūti",
  "brāhmaṇa": "the brāhmaṇa",
  "balir": "Bali Mahārāja",
  "ditir": "Diti",
  "parīkṣid": "Parīkṣit Mahārāja",
  "rudra": "Lord Śiva",
  "hiraṇyakaśipur": "Hiraṇyakaśipu",
  "indra": "Indra",
  "pṛthur": "Pṛthu Mahārāja",
  "nanda": "Nanda Mahārāja",
  "rukmiṇy": "Rukmiṇī",
  "vyāsa": "Vyāsadeva",
  "kaśyapa": "Kaśyapa Muni",
  "kapila": "Lord Kapila",
  "akrūra": "Akrūra",
  "citraketur": "Citraketu",
  "dhruva": "Dhruva Mahārāja",
  "manur": "Manu",
  "aditir": "Aditi",
  "mārkaṇḍeya": "Mārkaṇḍeya Ṛṣi",
  "śukra": "Śukrācārya",
  "dhṛtarāṣṭra": "Dhṛtarāṣṭra",
  "dharma": "Dharma",
  "mucukunda": "Mucukunda",
  "gurur": "the spiritual master",
  "kunty": "Queen Kuntī",
  "garga": "Garga Muni",
  // plural ūcuḥ groups
  "devā": "the demigods",
  "ṛṣaya": "the sages",
  "munaya": "the sages",
  "gopya": "the gopīs",
  "brāhmaṇā": "the brāhmaṇas",
  "mahiṣya": "the queens",
  "pracetasa": "the Pracetās",
  "prajāpataya": "the prajāpatis",
  // sandhi-contracted -ovāca bases
  "rāj": "the King",
  "brahm": "Lord Brahmā",
};

/** Strip honorific prefix and surrounding punctuation; lowercase. */
function normalizeMarkerName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[“”"'‘’()[\]]/g, "")
    .replace(/^ś[rṛ]ī[- ]/u, "")
    .trim();
}

/** Best-effort de-sandhi for display of markers not in the explicit map. */
function displayFromMarker(name: string): string | null {
  if (!name || name.length < 2) return null;
  // Multi-word leftovers like "sa h" (from "sa hovāca" — "he said") are not names.
  if (name.includes(" ")) return null;
  const known = SPEAKER_NAMES[name];
  if (known) return known;
  // Common nominative sandhi endings: devahūtir→devahūti, parīkṣid→parīkṣit, kunty→kuntī
  const desandhied = name.replace(/ir$/u, "i").replace(/ur$/u, "u").replace(/d$/u, "t").replace(/y$/u, "ī");
  const knownDesandhied = SPEAKER_NAMES[desandhied];
  if (knownDesandhied) return knownDesandhied;
  // The marker itself is explicit evidence — show it verbatim, capitalized.
  return desandhied.charAt(0).toUpperCase() + desandhied.slice(1);
}

/**
 * Parse one transliteration line as an uvāca marker.
 * Handles "<name> uvāca", "<names> ūcuḥ", and contracted "<name>ovāca"
 * (rājovāca, brahmovāca, śakuntalovāca…). "hovāca" forms ("sa hovāca" —
 * "he said") mark a speaker change with no identifiable name.
 */
export function parseUvaca(line: string): UvacaParse {
  const trimmed = line.trim().replace(/[“”"'‘’]+$/u, "").replace(/^[“”"'‘’]+/u, "");
  // "sa hovāca" / "… iti hovāca" — "he said": a speaker change with no name.
  if (/(^|\s)hovāca\s*$/iu.test(trimmed)) return { found: true, display: null };
  // "<name> uvāca" / "<names> ūcuḥ"
  const m = trimmed.match(/^(.{1,50}?)\s+(uvāca|ūcuḥ)\s*$/iu);
  if (m) {
    return { found: true, display: displayFromMarker(normalizeMarkerName(m[1])) };
  }
  // Contracted "<name>ovāca" (rājovāca = rājā uvāca; śakuntalovāca = śakuntalā uvāca)
  const c = trimmed.match(/^(\S{1,40})ovāca\s*$/iu);
  if (c) {
    const base = normalizeMarkerName(c[1]);
    if (!base || base === "h" || base.endsWith(" h")) return { found: true, display: null };
    const known = SPEAKER_NAMES[base];
    // Unknown -ovāca bases are names ending in -ā (śakuntal- → Śakuntalā).
    const display = known || (base.charAt(0).toUpperCase() + base.slice(1) + "ā");
    return { found: true, display };
  }
  return { found: false, display: null };
}

/** Leading integer of a verse number ("Text 16-17" → 16). */
function leadingInt(verseNumber: string): number {
  return parseInt((String(verseNumber).match(/\d+/) || ["0"])[0], 10);
}

/** BG dialogue states are explicit; elsewhere only the speaker is claimed. */
function stateFor(display: string, isBg: boolean): SpeakerState {
  if (!isBg) return { speaker: display };
  if (display === "the Supreme Lord") return { speaker: "Kṛṣṇa", speakerTo: "Arjuna" };
  if (display === "Arjuna") return { speaker: "Arjuna", speakerTo: "Kṛṣṇa" };
  return { speaker: display };
}

/**
 * Walk a chapter's verses in order, carrying the most recent uvāca speaker
 * forward, and return a map of verse id → confident speaker attribution.
 * Verses with no confident speaker are simply absent from the map.
 */
export function chapterSpeakerWalk(
  versesInChapter: { id: string; verse_number: string; transliteration?: string | null }[],
  scripture: string,
): Map<string, SpeakerState> {
  const isBg = (scripture || "").toUpperCase() === "BG";
  const isSb = (scripture || "").toUpperCase() === "SB";
  const out = new Map<string, SpeakerState>();
  if (!isBg && !isSb) return out; // uvāca attribution only where the rule is defined

  const sorted = [...versesInChapter].sort((a, b) => leadingInt(a.verse_number) - leadingInt(b.verse_number));
  // BG default: Kṛṣṇa addressing Arjuna. SB: unknown until the first marker.
  let state: SpeakerState | null = isBg ? { speaker: "Kṛṣṇa", speakerTo: "Arjuna" } : null;

  for (const v of sorted) {
    const lines = (v.transliteration || "").split("\n").map(s => s.trim()).filter(Boolean);
    const markers: { lineIdx: number; display: string | null }[] = [];
    lines.forEach((line, lineIdx) => {
      const p = parseUvaca(line);
      if (p.found) markers.push({ lineIdx, display: p.display });
    });

    let attribution: SpeakerState | null;
    if (markers.length === 0) {
      attribution = state;
    } else if (markers.length === 1 && markers[0].lineIdx === 0) {
      // The verse opens a new speech — confident.
      state = markers[0].display ? stateFor(markers[0].display, isBg) : null;
      attribution = state;
    } else {
      // Marker mid-verse (multi-śloka range) or several markers: the speaker
      // changes inside this verse — not confident, show no speaker for it.
      attribution = null;
      const last = markers[markers.length - 1];
      state = last.display ? stateFor(last.display, isBg) : null;
    }

    if (attribution) out.set(v.id, { ...attribution });
  }
  return out;
}
