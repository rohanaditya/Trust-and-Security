import { NextResponse } from 'next/server';
import { getAllItems, progressSummary } from '@/lib/knowledgeBase';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const filter = searchParams.get('filter');
  if (filter === 'open' || filter === 'settled') {
    const items = await getAllItems(filter);
    return NextResponse.json({ items });
  }

  const [items, summary] = await Promise.all([getAllItems(), progressSummary()]);
  return NextResponse.json({ items, summary });
}
