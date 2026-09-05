import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import {
  getItem,
  nextItemToAsk,
  recordUserAnswer,
  progressSummary,
} from '@/lib/knowledgeBase';
import { needsFollowUp, draftSessionOpener, draftConflictDialogue } from '@/lib/llm';
import { QuestionnaireItem } from '@/lib/types';

interface ChatRequest {
  sessionId: string;
  message: string;
  currentItemId: string | null;
  pendingFollowUp?: string | null; // the follow-up question we asked last turn, if any
}

function logTurn(sessionId: string, role: 'user' | 'assistant', content: string, itemId: string | null) {
  return supabaseAdmin.from('conversation_turns').insert({
    session_id: sessionId,
    role,
    content,
    related_item_id: itemId,
  });
}

async function presentItem(item: QuestionnaireItem): Promise<string> {
  if (item.status === 'conflict') {
    return draftConflictDialogue(item.question, item.conflicts);
  }
  if (item.status === 'verified' || item.status === 'vague') {
    const evidenceLines = item.evidence.map((e) => `- ${e.doc}${e.section ? ` (${e.section})` : ''}: ${e.detail.slice(0, 140)}...`).join('\n');
    const prefix = item.status === 'vague' ? 'the documents partially answer this' : 'the documents say';
    return (
      `For "${item.question}", ${prefix}: ${item.answer}\n\nEvidence:\n${evidenceLines}\n\n` +
      `Is this still accurate, and can you fill in what's missing?`
    );
  }
  // unknown
  return `I couldn't find anything in the documents about: "${item.question}". Can you tell me?`;
}

export async function POST(req: Request) {
  const body: ChatRequest = await req.json();
  const { sessionId, message, currentItemId, pendingFollowUp } = body;

  await logTurn(sessionId, 'user', message, currentItemId);

  // --- Case 1: the user is answering (or following up on) an in-progress item ---
  if (currentItemId) {
    const item = await getItem(currentItemId);
    if (!item) {
      return NextResponse.json({ error: `Unknown item ${currentItemId}` }, { status: 400 });
    }

    // If we'd asked a follow-up last turn, merge that context into what we record.
    const combinedAnswer = pendingFollowUp ? `${pendingFollowUp} -> ${message}` : message;

    if (!pendingFollowUp) {
      const followUp = await needsFollowUp(item.question, message);
      if (followUp.needs_follow_up && followUp.follow_up_question) {
        const reply = followUp.follow_up_question;
        await logTurn(sessionId, 'assistant', reply, currentItemId);
        return NextResponse.json({
          reply,
          currentItemId,
          pendingFollowUp: message, // remember what they said so far
          done: false,
        });
      }
    }

    const updated = await recordUserAnswer(currentItemId, combinedAnswer, { resolvesConflict: true });
    const summary = await progressSummary();

    const next = await nextItemToAsk();
    if (!next) {
      const reply = `Got it — recorded. That's everything: ${summary.confirmed}/${summary.total} items confirmed. Your questionnaire is ready to generate.`;
      await logTurn(sessionId, 'assistant', reply, null);
      return NextResponse.json({ reply, currentItemId: null, done: true, updatedItem: updated, summary });
    }

    const reply = `Got it — recorded.\n\n${await presentItem(next)}`;
    await logTurn(sessionId, 'assistant', reply, next.id);
    return NextResponse.json({
      reply,
      currentItemId: next.id,
      pendingFollowUp: null,
      done: false,
      updatedItem: updated,
      summary,
    });
  }

  // --- Case 2: fresh turn, nothing in progress — pick the next priority item ---
  const next = await nextItemToAsk();
  const summary = await progressSummary();
  if (!next) {
    const reply = 'All items are already confirmed. Your questionnaire is ready to generate.';
    await logTurn(sessionId, 'assistant', reply, null);
    return NextResponse.json({ reply, currentItemId: null, done: true, summary });
  }

  // First-ever turn of the session: open with the "search before asking" summary,
  // not a blank prompt or a jump straight into the first question.
  //
  // NOTE: draftSessionOpener (lib/llm.ts, P3-owned) still expects the old 5-field
  // summary shape (conflicting/user_confirmed). progressSummary() now returns the
  // richer 6-value enum (vague/conflict/confirmed). This adapter bridges the two so
  // the build doesn't break — P3 should update draftSessionOpener's signature to the
  // new field names and this adapter can then be deleted.
  if (message === '__start__') {
    const opener = draftSessionOpener({
      total: summary.total,
      verified: summary.verified,
      conflicting: summary.conflict,
      unknown: summary.unknown + summary.vague,
      user_confirmed: summary.confirmed,
      not_applicable: summary.not_applicable,
    });
    await logTurn(sessionId, 'assistant', opener, null);
    return NextResponse.json({ reply: opener, currentItemId: null, done: false, summary });
  }

  const reply = await presentItem(next);
  await logTurn(sessionId, 'assistant', reply, next.id);
  return NextResponse.json({ reply, currentItemId: next.id, pendingFollowUp: null, done: false, summary });
}
