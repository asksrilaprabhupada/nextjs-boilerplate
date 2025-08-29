// scripts/ingest-bg.mjs

// 1) Prefer IPv4 (avoids rare IPv6 DNS quirks on runners)
import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder("ipv4first");

// 2) Load .env locally, but never override CI env
import { config as loadEnv } from "dotenv";
loadEnv({ override: false });

import * as fs from "node:fs";
import * as path from "node:path";
import OpenAI from "openai";
import pg from "pg";

// ---- required env ----
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is missing.");
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const INPUT_FILE = process.env.INGEST_FILE || "public/bhagavadgita.json";

// Build a pg Pool from PG* vars (preferred) or DATABASE_URL if provided.
const DB_URL = process.env.DATABASE_URL;

const pool = DB_URL
  ? new pg.Pool({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new pg.Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 6543),
      database: process.env.PGDATABASE || "postgres",
      user: process.env.PGUSER || "postgres",
      password: process.env.PGPASSWORD,
      ssl: { rejectUnauthorized: false },
    });

if (!DB_URL && !process.env.PGPASSWORD) {
  throw new Error(
    "DB credentials missing: set PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD (recommended) or DATABASE_URL."
  );
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ---------- parse JSON (array, NDJSON, or concatenated objects) ----------
function parseVersesFile(text) {
  const t = (text || "").trim();

  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return [v];
  } catch (_) {}

  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const nd = [];
  let ok = lines.length > 0;
  for (const line of lines) {
    if (!line.startsWith("{")) { ok = false; break; }
    try { nd.push(JSON.parse(line)); } catch { ok = false; break; }
  }
  if (ok && nd.length) return nd;

  const objs = [];
  let depth = 0, start = -1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const slice = t.slice(start, i + 1);
        try { objs.push(JSON.parse(slice)); } catch {}
        start = -1;
      }
    }
  }
  if (objs.length) return objs;

  throw new Error("Could not parse bhagavadgita.json (expected array, NDJSON, or concatenated objects).");
}

// ---------- embeddings ----------
async function embed(text) {
  const clean = (text || "").trim();
  if (!clean) return null;
  const r = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: clean,
  });
  return r.data[0].embedding;
}

// ---------- ensure schema ----------
async function ensureSchema() {
  await pool.query(`
    create extension if not exists vector;

    create table if not exists passages (
      id bigserial primary key,
      work text not null,
      chapter int not null,
      verse int not null,
      sanskrit text,
      transliteration text,
      synonyms text,
      translation text,
      purport text,
      embedding vector(1536),
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );

    create unique index if not exists passages_unique_loc
      on passages(work, chapter, verse);

    do $$
    begin
      if not exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relname = 'passages_embedding_idx' and n.nspname = 'public'
      ) then
        execute 'create index passages_embedding_idx on passages using ivfflat (embedding vector_cosine_ops) with (lists = 100)';
      end if;
    end
    $$;
  `);
}

function textForEmbedding(p) {
  const parts = [
    p.sanskrit,
    p.transliteration,
    p.synonyms,
    p.translation,
    p.purport,
  ].filter(Boolean);
  const joined = parts.join("\n\n");
  return joined.length > 100_000 ? joined.slice(0, 100_000) : joined;
}

async function upsertPassage(p, vec) {
  const vecLiteral = vec ? JSON.stringify(vec) : null; // "[...]" pgvector literal
  await pool.query(
    `
    insert into passages
      (work, chapter, verse, sanskrit, transliteration, synonyms, translation, purport, embedding, updated_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector, now())
    on conflict (work, chapter, verse) do update set
      sanskrit = excluded.sanskrit,
      transliteration = excluded.transliteration,
      synonyms = excluded.synonyms,
      translation = excluded.translation,
      purport = excluded.purport,
      embedding = excluded.embedding,
      updated_at = now()
  `,
    [
      p.work || "bhagavad-gita",
      Number(p.chapter || p.chapter_number || 0),
      Number(p.verse || p.verse_number || 0),
      p.sanskrit || null,
      p.transliteration || null,
      p.synonyms || null,
      p.translation || null,
      p.purport || null,
      vecLiteral,
    ]
  );
}

// ---------- main ----------
async function main() {
  const filePath = path.resolve(INPUT_FILE);
  if (!fs.existsSync(filePath)) throw new Error(`INGEST_FILE not found at: ${filePath}`);

  const raw = await fs.promises.readFile(filePath, "utf8");
  const items = parseVersesFile(raw);

  console.log(`Parsed ${items.length} items from ${filePath}`);
  await ensureSchema();

  let done = 0, skipped = 0;
  for (const p of items) {
    try {
      const text = textForEmbedding(p);
      const vec = await embed(text);
      if (!vec) { skipped++; continue; }
      await upsertPassage(p, vec);
      done++;
      if (done % 25 === 0) console.log(`Upserted ${done}/${items.length}...`);
    } catch (e) {
      console.error(`Failed at chapter ${p.chapter} verse ${p.verse}:`, e.message);
    }
  }

  console.log(`Done. Upserted ${done}, skipped ${skipped}.`);
}

main()
  .catch((e) => {
    console.error("Fatal ingest error:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await pool.end(); } catch {}
  });
