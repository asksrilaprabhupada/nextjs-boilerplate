/**
 *  * Embedding helper for search queries.
  * Uses gemini-embedding-001 with 1536 dimensions.
   */

   const EMBEDDING_URL =
     "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent";
     const EXPECTED_DIMS = 1536;

     export async function embedQuery(text: string): Promise<number[]> {
       const geminiKey = process.env.GEMINI_API_KEY;
         if (!geminiKey) {
             console.error("GEMINI_API_KEY is not set");
                 return [];
                   }

                     const res = await fetch(`${EMBEDDING_URL}?key=${geminiKey}`, {
                         method: "POST",
                             headers: { "Content-Type": "application/json" },
                                 body: JSON.stringify({
                                       content: { parts: [{ text }] },
                                             outputDimensionality: EXPECTED_DIMS,
                                                   taskType: "RETRIEVAL_QUERY",
                                                       }),
                                                         });

                                                           if (!res.ok) {
                                                               console.error(`Embedding API error ${res.status}: ${await res.text()}`);
                                                                   return [];
                                                                     }

                                                                       const data = await res.json();
                                                                         const values: number[] = data?.embedding?.values ?? [];

                                                                           if (values.length !== EXPECTED_DIMS) {
                                                                               console.error(`Embedding dimension mismatch: expected ${EXPECTED_DIMS}, got ${values.length}`);
                                                                                   return [];
                                                                                     }

                                                                                       return values;
                                                                                       }
                                                                                       
 */