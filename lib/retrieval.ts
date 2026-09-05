import { supabaseAdmin } from './supabase';
import { embedOne } from './embeddings';
import { MatchedChunk } from './types';

/**
 * Retrieve chunks relevant to a questionnaire question across ALL documents.
 * We deliberately don't restrict by source_type — a policy, a VAPT finding,
 * and an infra diagram can all be evidence for the same question, and finding
 * them all is what lets conflict detection work.
 */
export async function retrieveForQuestion(
  question: string,
  matchCount = 8
): Promise<MatchedChunk[]> {
  const queryEmbedding = await embedOne(question, 'query');

  const { data, error } = await supabaseAdmin.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
  });

  if (error) throw new Error(`match_chunks failed: ${error.message}`);
  return data as MatchedChunk[];
}

// Similarity threshold below which we don't trust a chunk as real evidence.
// Tune this against your actual corpus — voyage-3-lite cosine sims for genuinely
// relevant hits usually land 0.4+; adjust after a few test queries.
export const RELEVANCE_THRESHOLD = 0.35;

export function filterRelevant(chunks: MatchedChunk[]): MatchedChunk[] {
  return chunks.filter((c) => c.similarity >= RELEVANCE_THRESHOLD);
}
