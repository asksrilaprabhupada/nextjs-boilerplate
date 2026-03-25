/**
 * 07-query-preprocessor.ts — Query Preprocessor
 *
 * Extracts search phrases from long devotee questions using Gemini Flash.
 * Short queries (under 15 words) pass through untouched.
 * Long queries get broken into 3-5 focused search phrases + tag terms.
 */
const GEMINI_FLASH_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
export interface PreprocessedQuery {
  searchPhrases: string[];
  tagTerms: string[];
  originalQuery: string;
  isLong: boolean;
}
export async function preprocessQuery(query: string): Promise<PreprocessedQuery> {
  const geminiKey = process.env.GEMINI_API_KEY || "";
  const wordCount = query.trim().split(/\s+/).length;
  // Short queries: don't call any API, just extract tag terms locally
  if (wordCount <= 15) {
    const tagTerms = query
      .toLowerCase()
      .replace(/[?!.,;:'"]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3);
    return {
      searchPhrases: [query],
      tagTerms,
      originalQuery: query,
      isLong: false,
    };
  }
  // Long queries: use Gemini Flash to extract key phrases
  try {
    const res = await fetch(`${GEMINI_FLASH_URL}?key=${geminiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `You help devotees search Śrīla Prabhupāda's books. Extract 3-5 short search phrases and 5-8 single-word topic terms from this question.
Question: "${query}"
Return ONLY valid JSON, no markdown:
{"searchPhrases": ["phrase1", "phrase2", "phrase3"], "tagTerms": ["term1", "term2"]}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 300,
          responseMimeType: "application/json",
        },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const parsed = JSON.parse(text);
      if (parsed.searchPhrases?.length > 0) {
        return {
          searchPhrases: parsed.searchPhrases.slice(0, 5),
          tagTerms: (parsed.tagTerms || [])
            .map((t: string) => t.toLowerCase())
            .slice(0, 8),
          originalQuery: query,
          isLong: true,
        };
      }
    }
  } catch (err) {
    console.error("Query preprocessing failed, using raw query:", err);
  }
  // Fallback: use raw query, extract tag terms locally
  const tagTerms = query
    .toLowerCase()
    .replace(/[?!.,;:'"]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return {
    searchPhrases: [query],
    tagTerms: tagTerms.slice(0, 8),
    originalQuery: query,
    isLong: false,
  };
}
