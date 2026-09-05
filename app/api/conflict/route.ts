import { NextResponse } from 'next/server';
import { flagConflict } from '@/lib/knowledgeBase';

interface ConflictRequest {
  questionId: string;
  detail: string;
  sources: string[];
}

/**
 * Minimal conflict persistence: flips a question's status to `conflict` and records
 * why, until the user resolves it. Called by the conversation layer when it detects a
 * contradiction — either from the harvest scan on open questions, or the
 * correction-detection check against settled ones.
 */
export async function POST(req: Request) {
  const body: ConflictRequest = await req.json();
  const { questionId, detail, sources } = body;
  if (!questionId || !detail) {
    return NextResponse.json({ error: 'questionId and detail are required' }, { status: 400 });
  }

  const updated = await flagConflict(questionId, detail, sources ?? []);
  return NextResponse.json({ item: updated });
}
