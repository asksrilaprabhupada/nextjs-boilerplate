/**
 * 17-verbatim-validator.ts — Server-side verbatim quote validator
 *
 * Before a search response is serialized, every block the essay will render
 * (verse translation + purport; prose/lecture/letter body) is re-fetched from
 * its source row by id and asserted verbatim:
 * normalize(rendered) ⊆ normalize(source). A block that fails is DROPPED and
 * counted — a tampered or drifted quote can never render. Normalization is
 * cosmetic only (NFC, quote/dash glyph unification, NBSP, whitespace
 * collapse); it never rewrites words.
 *
 * Failure policy: if the verification fetch itself errors (DB unreachable),
 * the validator fails OPEN — nothing is dropped and the response carries
 * `validated: false` so the condition is visible. Availability over
 * strictness; the sources being re-fetched are the same rows the hits came
 * from moments earlier.
 */

export interface ValidatableItem {
  /** "purport" rows live on the verses table — validated exactly like a verse. */
  type: "verse" | "purport" | "prose" | "lecture" | "letter";
  data: {
    id: string;
    translation?: string;
    purport?: string;
    body_text?: string;
  };
}

export interface SourceFetchClient {
  from(table: string): {
    select(columns: string): {
      in(column: string, values: string[]): PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
    };
  };
}

export interface ValidationResult<T extends ValidatableItem> {
  keptItems: T[];
  /** Blocks dropped because their text did not match their source row. */
  droppedBlocks: number;
  /** False only when the verification fetch itself failed (fail-open). */
  validated: boolean;
  droppedRefs: { id: string; type: string; reason: string }[];
  /** id → normalized full source text, for validating derived key-answer lines. */
  sourceText: Map<string, string>;
}

/** Cosmetic-only normalization: NFC + quote/dash glyphs + NBSP + whitespace. */
export function normalizeVerbatim(s: string): string {
  return (s || "")
    .normalize("NFC")
    .replace(/[‘’‚ʼ]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TABLE_FOR: Record<ValidatableItem["type"], { table: string; columns: string }> = {
  verse: { table: "verses", columns: "id,translation,purport" },
  purport: { table: "verses", columns: "id,translation,purport" },
  prose: { table: "prose_paragraphs", columns: "id,body_text" },
  lecture: { table: "transcript_paragraphs", columns: "id,body_text" },
  letter: { table: "letter_paragraphs", columns: "id,body_text" },
};

/**
 * Re-fetches every item's source row (≤4 batched selects) and drops any item
 * whose rendered fields are not verbatim substrings of the source. Never
 * throws.
 */
export async function validateMainFlow<T extends ValidatableItem>(
  items: T[],
  supabase: SourceFetchClient,
): Promise<ValidationResult<T>> {
  const failOpen = (reason: string): ValidationResult<T> => {
    console.error(`[verbatim-validator] verification fetch failed (${reason}) — failing open`);
    return { keptItems: items, droppedBlocks: 0, validated: false, droppedRefs: [], sourceText: new Map() };
  };

  if (items.length === 0) {
    return { keptItems: items, droppedBlocks: 0, validated: true, droppedRefs: [], sourceText: new Map() };
  }

  // Group ids by source table (an id can only belong to one table).
  const idsByType = new Map<ValidatableItem["type"], string[]>();
  for (const it of items) {
    const list = idsByType.get(it.type) || [];
    list.push(it.data.id);
    idsByType.set(it.type, list);
  }

  const sourceRows = new Map<string, Record<string, unknown>>();
  try {
    const fetches = [...idsByType.entries()].map(async ([type, ids]) => {
      const { table, columns } = TABLE_FOR[type];
      const { data, error } = await supabase.from(table).select(columns).in("id", ids);
      if (error) throw new Error(`${table}: ${JSON.stringify(error)}`);
      for (const row of data || []) sourceRows.set(String(row.id), row);
    });
    await Promise.all(fetches);
  } catch (err) {
    return failOpen(err instanceof Error ? err.message : String(err));
  }

  const keptItems: T[] = [];
  const droppedRefs: { id: string; type: string; reason: string }[] = [];
  const sourceText = new Map<string, string>();

  for (const it of items) {
    const src = sourceRows.get(it.data.id);
    if (!src) {
      droppedRefs.push({ id: it.data.id, type: it.type, reason: "source row not found" });
      continue;
    }

    if (it.type === "verse" || it.type === "purport") {
      const srcTranslation = normalizeVerbatim(String(src.translation ?? ""));
      const srcPurport = normalizeVerbatim(String(src.purport ?? ""));
      sourceText.set(it.data.id, `${srcTranslation} ${srcPurport}`.trim());

      const renderedTranslation = normalizeVerbatim(it.data.translation || "");
      if (renderedTranslation && !srcTranslation.includes(renderedTranslation)) {
        droppedRefs.push({ id: it.data.id, type: it.type, reason: "translation not verbatim" });
        continue;
      }
      const renderedPurport = normalizeVerbatim(it.data.purport || "");
      if (renderedPurport && !srcPurport.includes(renderedPurport)) {
        droppedRefs.push({ id: it.data.id, type: it.type, reason: "purport not verbatim" });
        continue;
      }
    } else {
      const srcBody = normalizeVerbatim(String(src.body_text ?? ""));
      sourceText.set(it.data.id, srcBody);

      const renderedBody = normalizeVerbatim(it.data.body_text || "");
      if (renderedBody && !srcBody.includes(renderedBody)) {
        droppedRefs.push({ id: it.data.id, type: it.type, reason: "body not verbatim" });
        continue;
      }
    }

    keptItems.push(it);
  }

  for (const d of droppedRefs) {
    console.error(`[verbatim-validator] dropped ${d.type} ${d.id}: ${d.reason}`);
  }

  return { keptItems, droppedBlocks: droppedRefs.length, validated: true, droppedRefs, sourceText };
}
