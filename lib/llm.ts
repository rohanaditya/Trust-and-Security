import Anthropic from '@anthropic-ai/sdk';
import { MatchedChunk } from './types';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface AnalysisResult {
  status: 'verified' | 'conflicting' | 'unknown';
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
- If two or more excerpts disagree (e.g. a policy says one thing, a finding/message contradicts it), set status "conflicting" and describe each side in "conflicts", citing chunk_ids for each side.
- If nothing in the excerpts answers the question, set status "unknown", proposed_answer must be null, cited_chunk_ids must be empty.
- Never cite a chunk_id that wasn't given to you.
- Never set status "verified" with an empty cited_chunk_ids array.
- confidence reflects how directly and unambiguously the excerpts answer the question (0 = no signal, 1 = explicit and unambiguous).
- Most security questions secretly ask "is this actually enforced", not "is this written down". A policy document is strong evidence of stated intent but weak evidence of practice; an infra config, admin log, or internal message is the reverse. If a policy says something is required but an infra/message excerpt suggests otherwise in practice, that is a real conflict — do not let the policy silently win.

Respond ONLY with JSON matching this shape, no prose, no markdown fences:
{
  "status": "verified" | "conflicting" | "unknown",
  "proposed_answer": string | null,
  "reasoning": string,
  "cited_chunk_ids": string[],
  "conflicts": [{ "detail": string, "chunk_ids": string[] }],
  "confidence": number
}`;

export async function analyzeQuestion(
  question: string,
  chunks: MatchedChunk[]
): Promise<AnalysisResult> {
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

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Question: ${question}\n\nExcerpts:\n\n${excerptBlock}`,
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
  conflicting: number;
  unknown: number;
  user_confirmed: number;
  not_applicable: number;
}): string {
  return (
    `I've reviewed your uploaded documents against the ${summary.total}-question security questionnaire.\n\n` +
    `Answered from your documents: ${summary.verified}.\n` +
    `Conflicts I need you to settle: ${summary.conflicting}.\n` +
    `Still unknown: ${summary.unknown}.\n` +
    (summary.not_applicable ? `Not applicable: ${summary.not_applicable}.\n` : '') +
    `\nI'd suggest starting with the conflicts — they're blocking otherwise-complete answers. Ready when you are.`
  );
}

/**
 * Conflict resolution dialogue — presents both sides with source + date and a
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
information to the person who can resolve it. Rules:
- Name both sources and, if given, dates.
- If one source describes actual practice (infra config, internal message, log) and the other
  describes stated policy, say which one you'd lean toward and why — but be explicit that you
  are not deciding for them.
- End with a direct question, not "can you clarify?" — ask exactly what's needed to resolve it.
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
  userAnswer: string
): Promise<{ needs_follow_up: boolean; follow_up_question: string | null }> {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 256,
    system: `You decide if a security-questionnaire answer is complete enough to record, or too vague
and needs one clarifying follow-up (e.g. a yes/no answer to a question that implies frequency, scope,
or automation still needs that detail). Respond ONLY with JSON:
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
