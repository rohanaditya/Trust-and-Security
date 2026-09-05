import { supabaseAdmin } from './supabase';
import { QuestionnaireItem, Evidence, Conflict } from './types';
import { retrieveForQuestion, filterRelevant } from './retrieval';
import { analyzeQuestion } from './llm';

export async function getAllItems(): Promise<QuestionnaireItem[]> {
  const { data, error } = await supabaseAdmin
    .from('questionnaire_items')
    .select('*')
    .order('priority', { ascending: true });
  if (error) throw error;
  return data as QuestionnaireItem[];
}

export async function getItem(id: string): Promise<QuestionnaireItem | null> {
  const { data, error } = await supabaseAdmin
    .from('questionnaire_items')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data as QuestionnaireItem;
}

/**
 * The "populate pass" — run once per item (typically once at ingest time, or
 * re-run on demand) to fill in what the documents already support.
 * This NEVER writes a bare answer without evidence — see llm.ts enforcement.
 */
export async function populateFromDocuments(item: QuestionnaireItem): Promise<QuestionnaireItem> {
  const chunks = filterRelevant(await retrieveForQuestion(item.question));
  const result = await analyzeQuestion(item.question, chunks);

  const citedChunks = chunks.filter((c) => result.cited_chunk_ids.includes(c.id));
  const evidence: Evidence[] = citedChunks.map((c) => ({
    doc: c.source_name,
    section: c.section_title ?? undefined,
    detail: c.content.slice(0, 300),
    similarity: c.similarity,
  }));

  const conflicts: Conflict[] = result.conflicts.map((c) => ({
    type: 'document_conflict',
    detail: c.detail,
    sources: chunks.filter((ch) => c.chunk_ids.includes(ch.id)).map((ch) => ch.source_name),
  }));

  const updated: Partial<QuestionnaireItem> = {
    status: conflicts.length > 0 ? 'conflicting' : result.status,
    answer: result.status === 'verified' ? result.proposed_answer : null,
    evidence,
    conflicts,
    confidence: result.confidence,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('questionnaire_items')
    .update(updated)
    .eq('id', item.id)
    .select()
    .single();
  if (error) throw error;
  return data as QuestionnaireItem;
}

/**
 * Called when the user provides/confirms an answer in conversation.
 * This is the ONLY other path (besides populateFromDocuments) allowed to set `answer`.
 */
export async function recordUserAnswer(
  id: string,
  userAnswer: string,
  opts?: { resolvesConflict?: boolean }
): Promise<QuestionnaireItem> {
  const { data, error } = await supabaseAdmin
    .from('questionnaire_items')
    .update({
      status: 'user_confirmed',
      answer: userAnswer,
      asked_user: true,
      last_user_note: userAnswer,
      confidence: 1,
      // Once the user has spoken, any prior document conflict is resolved by their word.
      conflicts: opts?.resolvesConflict ? [] : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as QuestionnaireItem;
}

/**
 * Priority queue for the conversation: conflicts first (most dangerous to leave
 * unresolved), then unknowns, then anything not yet confirmed by a user even if
 * documents look solid (cheap to double check), skipping anything already user_confirmed.
 */
export async function nextItemToAsk(): Promise<QuestionnaireItem | null> {
  const items = await getAllItems();
  const rank = (s: QuestionnaireItem['status']) =>
    ({ conflicting: 0, unknown: 1, verified: 2, user_confirmed: 3, not_applicable: 4 }[s]);

  const pending = items
    .filter((i) => i.status !== 'user_confirmed')
    .sort((a, b) => rank(a.status) - rank(b.status) || a.priority - b.priority);

  return pending[0] ?? null;
}

export async function progressSummary(): Promise<{
  total: number;
  verified: number;
  conflicting: number;
  unknown: number;
  user_confirmed: number;
}> {
  const items = await getAllItems();
  return {
    total: items.length,
    verified: items.filter((i) => i.status === 'verified').length,
    conflicting: items.filter((i) => i.status === 'conflicting').length,
    unknown: items.filter((i) => i.status === 'unknown').length,
    user_confirmed: items.filter((i) => i.status === 'user_confirmed').length,
  };
}
