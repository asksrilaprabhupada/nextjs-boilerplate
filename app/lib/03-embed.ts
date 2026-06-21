/**
 * 03-embed.ts — Voyage query embeddings (voyage-context-4, 1024-dim)
 *
 * Converts a search query into a 1024-number vector that matches the
 * embedding_context4 column in the database, enabling semantic search.
 */

const VOYAGE_URL = "https://api.voyageai.com/v1/contextualizedembeddings";
const MODEL = "voyage-context-4";
const EXPECTED_DIMS = 1024;

export async function embedQuery(text: string): Promise<number[]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    console.error("VOYAGE_API_KEY is not set");
    return [];
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
        inputs: [[text]], // one document, one chunk (the query itself)
        model: MODEL,
        input_type: "query", // queries use "query"; stored docs used "document"
        output_dimension: EXPECTED_DIMS,
        output_dtype: "float",
      }),
    });
  } catch (err) {
    console.error("Voyage embed request failed:", err);
    return [];
  }

  if (!res.ok) {
    console.error(`Voyage embed error ${res.status}: ${await res.text()}`);
    return [];
  }

  const data = await res.json();
  // Contextualized-embeddings response shape:
  //   { data: [ { data: [ { embedding: number[] } ] } ] }
  const values: number[] = data?.data?.[0]?.data?.[0]?.embedding ?? [];

  if (values.length !== EXPECTED_DIMS) {
    console.error(
      `Voyage dim mismatch: expected ${EXPECTED_DIMS}, got ${values.length}. ` +
        `Raw response keys: ${JSON.stringify(Object.keys(data || {}))}`
    );
    return [];
  }

  return values;
}
