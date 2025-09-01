import { NextRequest, NextResponse } from 'next/server';
import { TERMS } from '../../../lib/terms';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get('term') || '';
  const k = Number(searchParams.get('k') || 25);
  const term = TERMS[slug];
  if (!term) return NextResponse.json({ error: 'Unknown term' }, { status: 400 });

  const q = term.synonyms.map(s => `"${s}"`).join(' OR ');
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/search_passages_text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY!,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
    },
    body: JSON.stringify({ k, q, work_filter: 'Bhagavad-gita As It Is' }),
    cache: 'no-store',
  });

  if (!res.ok) return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  const rows = await res.json();
  return NextResponse.json({ label: term.label, items: rows });
}
