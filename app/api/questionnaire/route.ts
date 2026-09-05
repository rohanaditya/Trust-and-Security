import { NextResponse } from 'next/server';
import { getAllItems, progressSummary } from '@/lib/knowledgeBase';

export async function GET() {
  const [items, summary] = await Promise.all([getAllItems(), progressSummary()]);
  return NextResponse.json({ items, summary });
}
