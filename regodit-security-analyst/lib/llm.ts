import Anthropic from '@anthropic-ai/sdk';
import { MatchedChunk, AnswerType } from './types';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface AnalysisResult {
  status: 'verified' | 'conflict' | 'unknown';
  proposed_answer: string | null;
  reasoning: string;
  cited_chunk_ids: string[];      // must reference real chunk ids — enforced below
  conflicts: { detail: string; chunk_ids: string[] }[];
  confidence: number;             // 0-1
}

const SYSTEM_PROMPT = `You are a security-questionnaire analyst. You are given a question and a set of
document excerpts (each with an id). Your job is ONLY to say what the excerpts support — never invent
facts not present in the excerpts.

Rules:
- If the excerpts clearly and consistently answer the question, set status "verified" and cite the chunk_ids that support it.
- If two or more excerpts disagree (e.g. a policy says one thing, a finding/message contradicts it), set status "conflict" and describe each side in "conflicts", citing chunk_ids for each side.
- If nothing in the excerpts answers the question, set status "unknown", proposed_answer must be null, cited_chunk_ids must be empty.
- Never cite a chunk_id that wasn't given to you.
- Never set status "verified" with an empty cited_chunk_ids array.
- confidence reflects how directly and unambiguously the excerpts answer the question (0 = no signal, 1 = explicit and unambiguous).
- Most security questions secretly ask "is this actually enforced", not "is this written down". A policy document is strong evidence of stated intent but weak evidence of practice; an infra config, admin log, or internal message is the reverse. If a policy says something is required but an infra/message excerpt suggests otherwise in practice, that is a real conflict — do not let the policy silently win.

Respond ONLY with JSON matching this shape, no prose, no markdown fences:
{
  "status": "verified" | "conflict" | "unknown",
  "proposed_answer": string | null,
  "reasoning": string,
  "cited_chunk_ids": string[],
  "conflicts": [{ "detail": string, "chunk_ids": string[] }],
  "confidence": number
}`;

// Q52 in the source questionnaire is a malformed row — its question text is literally
// the string "52.0" (see AI_SECURITY_ANALYST_SPEC.md §2.2). It isn't a real question, so
// it should never trigger a retrieval call or a "couldn't find anything about 52.0" prompt
// to the user. Short-circuit it here since this file is the only one we're touching this
// round — schema/seed still label it a normal 'unknown' row until someone fixes seeding.
const MALFORMED_QUESTION_TEXT = '52.0';

export async function analyzeQuestion(
  question: string,
  chunks: MatchedChunk[],
  answerType: AnswerType = 'text'
): Promise<AnalysisResult> {
  if (question.trim() === MALFORMED_QUESTION_TEXT) {
    return {
      status: 'verified',
      proposed_answer: 'Not applicable — malformed row in source questionnaire (no question text).',
      reasoning: 'Question text is a bare number ("52.0"), not a real question. Marked resolved rather than asked to the user.',
      cited_chunk_ids: [],
      conflicts: [],
      confidence: 1,
    };
  }

  if (chunks.length === 0) {
    return {
      status: 'unknown',
      proposed_answer: null,
      reasoning: 'No relevant document chunks were retrieved.',
      cited_chunk_ids: [],
      conflicts: [],
      confidence: 0,
    };
  }

  const excerptBlock = chunks
    .map((c) => `[chunk_id: ${c.id}] (source: ${c.source_name}${c.section_title ? `, section: ${c.section_title}` : ''})\n${c.content}`)
    .join('\n\n---\n\n');

  const answerTypeNote =
    answerType === 'boolean'
      ? 'This question expects a Yes/No answer — proposed_answer should be exactly "Yes" or "No" when verified.'
      : answerType === 'document_request'
      ? 'This question asks the vendor to provide/attach a document, not describe something in prose. Only mark "verified" if an excerpt is itself evidence such a document exists — proposed_answer should just confirm the document exists, not restate its contents.'
      : '';

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Question: ${question}${answerTypeNote ? `\n(${answerTypeNote})` : ''}\n\nExcerpts:\n\n${excerptBlock}`,
      },
    ],
  });

  const textBlock = msg.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('No text response from Claude');

  let parsed: AnalysisResult;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error(`Failed to parse LLM JSON: ${textBlock.text}`);
  }

  // --- Enforcement layer: this is what actually implements the Golden Rule ---
  // The model's raw output is not trusted; we validate it against the real chunk set.
  const validChunkIds = new Set(chunks.map((c) => c.id));
  const allCitedIds = [
    ...parsed.cited_chunk_ids,
    ...parsed.conflicts.flatMap((c) => c.chunk_ids),
  ];
  const hasInvalidCitation = allCitedIds.some((id) => !validChunkIds.has(id));
  if (hasInvalidCitation) {
    // Model cited a chunk that doesn't exist — refuse to trust this result at all.
    return {
      status: 'unknown',
      proposed_answer: null,
      reasoning: 'Model produced an unverifiable citation; discarding result.',
      cited_chunk_ids: [],
      conflicts: [],
      confidence: 0,
    };
  }
  if (parsed.status === 'verified' && parsed.cited_chunk_ids.length === 0) {
    // Model claimed verified with no evidence — downgrade, never trust a bare claim.
    return { ...parsed, status: 'unknown', proposed_answer: null, confidence: 0 };
  }

  return parsed;
}

/**
 * Session opener — the first message of the conversation. Must prove "search before
 * asking" happened, not open with a blank prompt. Call this once with the progress
 * summary before showing the chat.
 */
export function draftSessionOpener(summary: {
  total: number;
  verified: number;
  conflict: number;
  unknown: number;
  confirmed: number;
  not_applicable: number;
}): string {
  return (
    `I've reviewed your uploaded documents against the ${summary.total}-question security questionnaire.\n\n` +
    `Answered from your documents: ${summary.verified}.\n` +
    `Conflicts I need you to settle: ${summary.conflict}.\n` +
    `Still unknown: ${summary.unknown}.\n` +
    (summary.not_applicable ? `Not applicable: ${summary.not_applicable}.\n` : '') +
    `\nI'd suggest starting with the conflicts — they're blocking otherwise-complete answers. Ready when you are.`
  );
}

/**
 * Conflict resolution dialogue — presents both sides with source names and a
 * recommendation, but never resolves silently. The user's reply is what actually
 * writes the answer (via recordUserAnswer).
 */
export async function draftConflictDialogue(
  question: string,
  conflicts: { detail: string; sources: string[] }[]
): Promise<string> {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    system: `You write one short message presenting a conflict between two sources of security
information to the person who can resolve it. You are given each side's detail and its source
filename(s) only — no document dates are available, so never invent one.

Rules:
- Name both sources by the exact filename/label given.
- If a source's name suggests it's stated policy (e.g. contains "Policy", "Standard") and another
  suggests actual practice or configuration (e.g. an internal message export, an infra config, a
  log), say which one you'd lean toward for "what actually happens today" and why — but be explicit
  that you are not deciding for them. If you can't tell which is which from the names alone, lay out
  both sides neutrally instead of guessing.
- End with a direct question naming the specific fact still unresolved, not "can you clarify?"
- Keep it to 3-4 sentences.`,
    messages: [
      {
        role: 'user',
        content: `Question: ${question}\n\nConflicts:\n${conflicts.map((c) => `- ${c.detail} (sources: ${c.sources.join(', ')})`).join('\n')}`,
      },
    ],
  });
  const textBlock = msg.content.find((b) => b.type === 'text');
  return textBlock && textBlock.type === 'text' ? textBlock.text : question;
}

/**
 * Used in the conversation loop to decide whether a user's answer needs a follow-up
 * (e.g. "yes" to "do you do backups?" needs a follow-up on frequency/automation).
 */
export async function needsFollowUp(
  question: string,
  userAnswer: string,
  answerType: AnswerType = 'text'
): Promise<{ needs_follow_up: boolean; follow_up_question: string | null }> {
  // Boolean and document_request questions in this schema never carry a hidden extra
  // detail the way cadence/process questions do — those are always answer_type 'text'
  // (e.g. Q59 access-review cadence, Q41 backup process). Skip the LLM call for both.
  if (answerType === 'boolean' || answerType === 'document_request') {
    return { needs_follow_up: false, follow_up_question: null };
  }

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 256,
    system: `You decide if a security-questionnaire answer is complete enough to record, or too vague
and needs one clarifying follow-up. This question expects a substantive answer (not yes/no) — a
one-word or evasive reply ("sometimes", "yeah we handle that") is NOT complete; follow up asking for
the specific detail the question is actually after (frequency, scope, automation, tooling, etc).
Prefer no follow-up over a redundant one — a follow-up restating information already given is worse
than skipping it.

Respond ONLY with JSON:
{"needs_follow_up": boolean, "follow_up_question": string | null}`,
    messages: [
      { role: 'user', content: `Question: ${question}\nUser answer: ${userAnswer}` },
    ],
  });
  const textBlock = msg.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return { needs_follow_up: false, follow_up_question: null };
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return { needs_follow_up: false, follow_up_question: null };
  }
}

/**
 * Correction detection — for when a user's message contradicts an item that's already
 * `user_confirmed`, not the one currently in progress. Two-stage: a cheap keyword check
 * runs first (no LLM cost on the common case where nothing is being corrected), and only
 * on a hit do we spend a call confirming it's a real contradiction. Scoped to a single
 * prior item (the most recently confirmed one) rather than scanning full history — cheap
 * and correct for a single-item conversation loop; a general history-wide correction
 * scan would need the route's session model extended, which is out of scope this round.
 */
const CORRECTION_TRIGGERS = [
  'actually', "that's outdated", "that's wrong", 'no, we changed', 'we changed that',
  "that's no longer", 'correction', 'to correct that', 'i misspoke', 'scratch that',
];

export function looksLikeCorrection(message: string): boolean {
  const lower = message.toLowerCase();
  return CORRECTION_TRIGGERS.some((t) => lower.includes(t));
}

export interface CorrectionCheck {
  is_correction: boolean;
  new_answer: string | null;
  message: string | null;
}

export async function detectCorrection(
  priorQuestion: string,
  priorAnswer: string,
  userMessage: string
): Promise<CorrectionCheck> {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 300,
    system: `The user previously gave a confirmed answer to a security-questionnaire item. They just
said something that might be correcting that answer. Decide if it actually contradicts the prior
answer — not just rephrasing it, adding detail to it, or talking about something unrelated.

Respond ONLY with JSON:
{"is_correction": boolean, "new_answer": string | null, "message": string | null}

If is_correction is true:
- new_answer: the corrected answer, extracted from what the user said.
- message: one short sentence confirming the update, naming both the old and new answer, e.g.
  "Updated — that changes your answer to 'Do you require MFA?' from 'No' to 'Yes'."
If is_correction is false, new_answer and message must both be null. Do not guess a correction that
isn't clearly there — false positives here silently overwrite a confirmed answer, which is worse
than missing one.`,
    messages: [
      {
        role: 'user',
        content: `Prior question: ${priorQuestion}\nPrior confirmed answer: ${priorAnswer}\nUser's new message: ${userMessage}`,
      },
    ],
  });
  const correctionText = msg.content.find((b) => b.type === 'text');
  if (!correctionText || correctionText.type !== 'text') {
    return { is_correction: false, new_answer: null, message: null };
  }
  try {
    return JSON.parse(correctionText.text);
  } catch {
    return { is_correction: false, new_answer: null, message: null };
  }
}