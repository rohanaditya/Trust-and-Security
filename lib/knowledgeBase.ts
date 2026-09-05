import { supabaseAdmin } from './supabase';
import { QuestionnaireItem, Evidence, Conflict, DocHit } from './types';
import { retrieveForQuestion, filterRelevant } from './retrieval';
import { analyzeQuestion } from './llm';

const VERIFIED_CONFIDENCE_THRESHOLD = 0.6;
const SPAN_MAX_LENGTH = 500;

export async function getAllItems(filter?: 'open' | 'settled'): Promise<QuestionnaireItem[]> {
  let query = supabaseAdmin.from('questionnaire_items').select('*').order('priority', { ascending: true });
  if (filter === 'open') query = query.in('status', ['unknown', 'vague']);
  if (filter === 'settled') query = query.in('status', ['verified', 'confirmed']);
  const { data, error } = await query;
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

async function getDocHits(questionId: string): Promise<DocHit[]> {
  const { data, error } = await supabaseAdmin
    .from('doc_hits')
    .select('*')
    .eq('question_id', questionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data as DocHit[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Deterministic, LLM-free status derivation from the stored doc_hits (+ whatever's
 * already on the item). Runs after every doc_hits write. Never touches items that are
 * already `not_applicable` (permanent) or `confirmed` (only applyCorrection changes those).
 */
export async function recomputeStatus(questionId: string): Promise<QuestionnaireItem> {
  const item = await getItem(questionId);
  if (!item) throw new Error(`Unknown item ${questionId}`);
  if (item.status === 'not_applicable' || item.status === 'confirmed') return item;

  const hits = await getDocHits(questionId);

  let status: QuestionnaireItem['status'];
  let answer: string | null = item.answer;
  let evidence: Evidence[] = item.evidence;
  let conflicts: Conflict[] = item.conflicts;

  if (hits.length === 0) {
    status = 'unknown';
    answer = null;
    evidence = [];
    conflicts = [];
  } else {
    const groups = new Map<string, DocHit[]>();
    for (const h of hits) {
      const key = normalize(h.value);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(h);
    }

    evidence = hits.map((h) => ({
      doc: h.source_doc,
      detail: h.span,
    }));

    if (groups.size > 1) {
      status = 'conflict';
      answer = null;
      conflicts = [...groups.entries()].map(([, groupHits]) => ({
        type: 'document_conflict',
        detail: groupHits[0].value,
        sources: groupHits.map((h) => h.source_doc),
      }));
    } else {
      conflicts = [];
      answer = hits[hits.length - 1].value;
      status = item.confidence >= VERIFIED_CONFIDENCE_THRESHOLD ? 'verified' : 'vague';
    }
  }

  const { data, error } = await supabaseAdmin
    .from('questionnaire_items')
    .update({ status, answer, evidence, conflicts, updated_at: new Date().toISOString() })
    .eq('id', questionId)
    .select()
    .single();
  if (error) throw error;
  return data as QuestionnaireItem;
}

/**
 * The "populate pass" — run once per item (typically once at ingest time, or
 * re-run on demand) to fill in what the documents already support. Writes one doc_hit
 * row per candidate value found (0, 1, or several), then derives the item's status
 * from those rows via recomputeStatus. This NEVER writes a bare answer without evidence.
 */
export async function populateFromDocuments(item: QuestionnaireItem): Promise<QuestionnaireItem> {
  const chunks = filterRelevant(await retrieveForQuestion(item.question));
  const result = await analyzeQuestion(item.question, chunks);

  const rows: Omit<DocHit, 'id' | 'created_at'>[] = [];

  if (result.status === 'verified' && result.proposed_answer) {
    const cited = chunks.filter((c) => result.cited_chunk_ids.includes(c.id));
    for (const c of cited) {
      rows.push({
        question_id: item.id,
        value: result.proposed_answer,
        source_doc: c.source_name,
        source_date: c.authored_at,
        span: c.content.slice(0, SPAN_MAX_LENGTH),
      });
    }
  } else if (result.status === 'conflicting') {
    for (const conflict of result.conflicts) {
      const sideChunks = chunks.filter((c) => conflict.chunk_ids.includes(c.id));
      for (const c of sideChunks) {
        rows.push({
          question_id: item.id,
          value: conflict.detail,
          source_doc: c.source_name,
          source_date: c.authored_at,
          span: c.content.slice(0, SPAN_MAX_LENGTH),
        });
      }
    }
  }

  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from('doc_hits').insert(rows);
    if (error) throw error;
  }

  // Stash the raw LLM confidence on the item so recomputeStatus can distinguish
  // verified vs vague for a single-value group without a second LLM call.
  await supabaseAdmin
    .from('questionnaire_items')
    .update({ confidence: result.confidence, updated_at: new Date().toISOString() })
    .eq('id', item.id);

  return recomputeStatus(item.id);
}

/**
 * Called when the user provides/confirms an answer in conversation (the normal,
 * non-correction path — e.g. answering an unknown/vague/conflict item for the first time).
 */
export async function recordUserAnswer(
  id: string,
  userAnswer: string,
  opts?: { resolvesConflict?: boolean }
): Promise<QuestionnaireItem> {
  const { data, error } = await supabaseAdmin
    .from('questionnaire_items')
    .update({
      status: 'confirmed',
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
 * Distinct write path for explicit corrections to an already-settled (verified/confirmed)
 * answer — used only after the user has confirmed the change via dialogue, never
 * automatically. Overwrite-with-a-record: no full supersede chain this round, doc_hits
 * are left untouched as the historical record of what documents said.
 */
export async function applyCorrection(
  questionId: string,
  oldValue: string,
  newValue: string
): Promise<QuestionnaireItem> {
  const item = await getItem(questionId);
  if (!item) throw new Error(`Unknown item ${questionId}`);
  if (item.answer !== oldValue) {
    console.warn(
      `applyCorrection: oldValue mismatch for ${questionId} — expected "${item.answer}", got "${oldValue}". Proceeding anyway.`
    );
  }

  const { data, error } = await supabaseAdmin
    .from('questionnaire_items')
    .update({
      status: 'confirmed',
      answer: newValue,
      asked_user: true,
      last_user_note: newValue,
      confidence: 1,
      conflicts: [],
      updated_at: new Date().toISOString(),
    })
    .eq('id', questionId)
    .select()
    .single();
  if (error) throw error;
  return data as QuestionnaireItem;
}

/**
 * Minimal conflict persistence (no separate conflicts table this round): flips the
 * item's status to `conflict` and appends a Conflict entry, so it stays visible until
 * the user resolves it (via recordUserAnswer or applyCorrection). Called by the
 * conversation layer when it flags a contradiction — from the harvest scan on open
 * questions, or the correction-detection check against settled ones.
 */
export async function flagConflict(
  questionId: string,
  detail: string,
  sources: string[]
): Promise<QuestionnaireItem> {
  const item = await getItem(questionId);
  if (!item) throw new Error(`Unknown item ${questionId}`);

  const conflict: Conflict = { type: 'conversation_conflict', detail, sources };
  const { data, error } = await supabaseAdmin
    .from('questionnaire_items')
    .update({
      status: 'conflict',
      conflicts: [...item.conflicts, conflict],
      updated_at: new Date().toISOString(),
    })
    .eq('id', questionId)
    .select()
    .single();
  if (error) throw error;
  return data as QuestionnaireItem;
}

/**
 * Priority queue for the conversation: conflicts first (most dangerous to leave
 * unresolved), then vague/unknown, then anything not yet confirmed by a user even if
 * documents look solid (cheap to double check), skipping anything already confirmed
 * or not_applicable.
 */
export async function nextItemToAsk(): Promise<QuestionnaireItem | null> {
  const items = await getAllItems();
  const rank = (s: QuestionnaireItem['status']) =>
    ({ conflict: 0, vague: 1, unknown: 1, verified: 2, confirmed: 3, not_applicable: 4 }[s]);

  const pending = items
    .filter((i) => i.status !== 'confirmed' && i.status !== 'not_applicable')
    .sort((a, b) => rank(a.status) - rank(b.status) || a.priority - b.priority);

  return pending[0] ?? null;
}

export async function progressSummary(): Promise<{
  total: number;
  verified: number;
  vague: number;
  conflict: number;
  unknown: number;
  confirmed: number;
  not_applicable: number;
}> {
  const items = await getAllItems();
  return {
    total: items.length,
    verified: items.filter((i) => i.status === 'verified').length,
    vague: items.filter((i) => i.status === 'vague').length,
    conflict: items.filter((i) => i.status === 'conflict').length,
    unknown: items.filter((i) => i.status === 'unknown').length,
    confirmed: items.filter((i) => i.status === 'confirmed').length,
    not_applicable: items.filter((i) => i.status === 'not_applicable').length,
  };
}
