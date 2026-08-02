/**
 * 03-embed.ts — Voyage query embeddings (voyage-context-4, 1024-dim)
 *
 * Converts search queries into 1024-number vectors that match the
 * embedding_context4 column in the database, enabling semantic search.
 * embedQueries() batches any number of queries into ONE API call (each query
 * is its own one-chunk document) — the multi-query expansion embeds the
 * original + all variants together.
 */

const VOYAGE_URL = "https://api.voyageai.com/v1/contextualizedembeddings";
/** Exported so durable telemetry records the exact embedding space in use. */
export const VOYAGE_CONTEXT_MODEL = "voyage-context-4";
const EXPECTED_DIMS = 1024;

/**
 * Embeds many queries in a single Voyage call. Returns one vector per input,
 * in input order; a failed call (or a dim mismatch on an entry) yields [] for
 * the affected entries so callers degrade the same way embedQuery always has.
 */
export async function embedQueries(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const empty = texts.map(() => [] as number[]);

  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    console.error("VOYAGE_API_KEY is not set");
    return empty;
  }

  let res: Response;
  try {
    res = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        inputs: texts.map((t) => [t]), // one document per query, one chunk each
        model: VOYAGE_CONTEXT_MODEL,
        input_type: "query", // queries use "query"; stored docs used "document"
        output_dimension: EXPECTED_DIMS,
        output_dtype: "float",
      }),
    });
  } catch (err) {
    console.error("Voyage embed request failed:", err);
    return empty;
  }

  if (!res.ok) {
    console.error(`Voyage embed error ${res.status}: ${await res.text()}`);
    return empty;
  }

  const data = await res.json();
  // Contextualized-embeddings response shape:
  //   { data: [ { index, data: [ { embedding: number[] } ] } ] }
  // Entries carry their input index — map by it in case order ever differs.
  const byIndex = new Map<number, number[]>();
  for (let i = 0; i < (data?.data?.length ?? 0); i++) {
    const entry = data.data[i];
    const idx = typeof entry?.index === "number" ? entry.index : i;
    byIndex.set(idx, entry?.data?.[0]?.embedding ?? []);
  }

  return texts.map((_, i) => {
    const values = byIndex.get(i) ?? [];
    if (values.length !== EXPECTED_DIMS) {
      if (values.length > 0) {
        console.error(`Voyage dim mismatch at input ${i}: expected ${EXPECTED_DIMS}, got ${values.length}.`);
      }
      return [];
    }
    return values;
  });
}

export async function embedQuery(text: string): Promise<number[]> {
  const [values] = await embedQueries([text]);
  return values ?? [];
}
