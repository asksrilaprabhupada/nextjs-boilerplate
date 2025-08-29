import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder("ipv4first");
import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -------- Robust JSON parsing (array, NDJSON, or concatenated objects) --------
function parseVersesFile(text) {
  const t = text.trim();

  // A) Standard JSON (array or single object)
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return [v];
  } catch (_) {}

  // B) NDJSON: one JSON object per line
  const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const nd = [];
  let ok = true;
  for (const line of lines) {
    if (!line.startsWith("{")) { ok = false; break; }
    try { nd.push(JSON.parse(line)); } catch { ok = false; break; }
  }
  if (ok && nd.length) return nd;

  // C) Concatenated objects: {}{}{} with no commas
  const objs = [];
  let depth = 0, start = -1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const slice = t.slice(start, i + 1);
        try { objs.push(JSON.parse(slice)); } catch {}
        start = -1;
      }
    }
  }
  if (objs.length) return objs;

  throw new Error("Could not parse bhagavadgita.json. Expected array, NDJSON, or concatenated objects.");
}

async function embed(text) {
  const clean = (text || "").trim();
  if (!clean) return null;
  const r = await openai.embeddings.create({
    model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    input: clean,
  });
  return r.data[0].embedding;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const file = path.join(process.cwd(), "public", "bhagavadgita.json");
  const rawText = fs.readFileSync(file, "utf8");
  const items = parseVersesFile(rawText);

  console.log(`Found ${items.length} entries in bhagavadgita.json`);

  // Ensure unique key for upsert (safe if it already exists)
  await pool.query(
    `create unique index if not exists passages_unique_loc on passages(work, chapter, verse);`
  );

  let count = 0;
  for (const v of items) {
    const work  = v.work || "Bhagavad-gita As It Is";
    const chap  = Number(v.chapter ?? v.Chapter ?? 0);
    const ver   = Number(v.verse   ?? v.Verse   ?? 0);
    const s     = v.sections || {};

    const sanskrit        = s.sanskrit ?? s.devanagari ?? null;
    const transliteration = s.transliteration ?? null;
    const synonyms        = s.synonyms ?? null;
    const translation     = s.translation ?? null;
    const purport         = s.purport ?? null;

    const emb = await embed([translation, purport].filter(Boolean).join("\n"));

    await pool.query(
      `insert into passages
       (work, chapter, verse, sanskrit, transliteration, synonyms, translation, purport, embedding)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (work, chapter, verse) do update set
         sanskrit = excluded.sanskrit,
         transliteration = excluded.transliteration,
         synonyms = excluded.synonyms,
         translation = excluded.translation,
         purport = excluded.purport,
         embedding = excluded.embedding`,
      [work, chap, ver, sanskrit, transliteration, synonyms, translation, purport, emb]
    );

    count++;
    if (count % 50 === 0) process.stdout.write(`${count}\n`);
    else process.stdout.write(".");
  }

  console.log(`\n✅ Ingestion complete. Inserted/updated ${count} rows.`);
  await pool.end();
}

main().catch(err => {
  console.error("\n❌ Ingestion failed:", err.stack || err.message);
  process.exit(1);
});
