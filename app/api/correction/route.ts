import { NextResponse } from 'next/server';
import { applyCorrection } from '@/lib/knowledgeBase';

interface CorrectionRequest {
  questionId: string;
  oldValue: string;
  newValue: string;
}

/**
 * Distinct write path from the normal answer-write (/api/chat). Only for explicit
 * corrections to an already-settled answer, and only after the user has confirmed the
 * change via the conversation dialogue — the conversation layer decides when to call
 * this, it is never automatic.
 */
export async function POST(req: Request) {
  const body: CorrectionRequest = await req.json();
  const { questionId, oldValue, newValue } = body;
  if (!questionId || newValue === undefined) {
    return NextResponse.json({ error: 'questionId and newValue are required' }, { status: 400 });
  }

  const updated = await applyCorrection(questionId, oldValue, newValue);
  return NextResponse.json({ item: updated });
}
