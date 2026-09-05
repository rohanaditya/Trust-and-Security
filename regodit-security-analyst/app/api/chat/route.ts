import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import {
  getItem,
  nextItemToAsk,
  recordUserAnswer,
  progressSummary,
  getMostRecentlyConfirmedItem,
} from '@/lib/knowledgeBase';
import { needsFollowUp, draftSessionOpener, draftConflictDialogue, looksLikeCorrection, detectCorrection } from '@/lib/llm';
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
  if (item.status === 'verified') {
    const evidenceLines = item.evidence.map((e) => `- ${e.doc}${e.section ? ` (${e.section})` : ''}: ${e.detail.slice(0, 140)}...`).join('\n');
    return (
      `For "${item.question}", the documents say: ${item.answer}\n\nEvidence:\n${evidenceLines}\n\n` +
      `Is this still accurate?`
    );
  }
  // unknown
  return `I couldn't find anything in the documents about: "${item.question}". Can you tell me?`;
}

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { sessionId, message, currentItemId, pendingFollowUp } = body;

  try {

  await logTurn(sessionId, 'user', message, currentItemId);

  // --- Correction check: does this message contradict an already-confirmed item? ---
  // Scoped to the single most recently confirmed item, not a full history scan — see
  // llm.ts's detectCorrection doc comment. Runs before the normal flow and, on a hit,
  // returns early without disturbing currentItemId/pendingFollowUp.
  if (message !== '__start__' && looksLikeCorrection(message)) {
    const priorItem = await getMostRecentlyConfirmedItem(currentItemId);
    if (priorItem && priorItem.answer) {
      const check = await detectCorrection(priorItem.question, priorItem.answer, message);
      if (check.is_correction && check.new_answer) {
        const updated = await recordUserAnswer(priorItem.id, check.new_answer, { resolvesConflict: true });
        const summary = await progressSummary();
        const reply = check.message ?? `Updated your answer to "${priorItem.question}".`;
        await logTurn(sessionId, 'assistant', reply, priorItem.id);
        return NextResponse.json({
          reply,
          currentItemId,
          pendingFollowUp,
          done: false,
          updatedItem: updated,
          summary,
        });
      }
    }
  }

  // --- Case 1: the user is answering (or following up on) an in-progress item ---
  if (currentItemId) {
    const item = await getItem(currentItemId);
    if (!item) {
      return NextResponse.json({ error: `Unknown item ${currentItemId}` }, { status: 400 });
    }

    // If we'd asked a follow-up last turn, merge that context into what we record.
    const combinedAnswer = pendingFollowUp ? `${pendingFollowUp} -> ${message}` : message;

    if (!pendingFollowUp) {
      const followUp = await needsFollowUp(item.question, message, item.answer_type);
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
  if (message === '__start__') {
    const opener = draftSessionOpener({ ...summary, not_applicable: 0 });
    await logTurn(sessionId, 'assistant', opener, null);
    return NextResponse.json({ reply: opener, currentItemId: null, done: false, summary });
  }

  const reply = await presentItem(next);
  await logTurn(sessionId, 'assistant', reply, next.id);
  return NextResponse.json({ reply, currentItemId: next.id, pendingFollowUp: null, done: false, summary });
  } catch (err) {
    const detail = err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as Record<string, unknown>).message)
        : JSON.stringify(err);
    console.error('[chat route]', detail, err);
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}