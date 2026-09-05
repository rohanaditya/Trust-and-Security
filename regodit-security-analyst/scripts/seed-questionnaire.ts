/**
 * Usage: npm run seed
 * Loads the seed questionnaire items into Supabase, then immediately runs the
 * document-populate pass on each one — this is your "search before asking" step,
 * done once up front so the conversation starts already knowing what it knows.
 */
import fs from 'fs';
import path from 'path';
import { supabaseAdmin } from '../lib/supabase';
import { populateFromDocuments } from '../lib/knowledgeBase';

// Q52's question text in the source sheet is literally "52.0" — a malformed row,
// not a real question (see AI_SECURITY_ANALYST_SPEC.md §2.2). Seed it directly as
// not_applicable and never send it through retrieval or the LLM.
const MALFORMED_IDS = new Set(['52_52_0']);

async function main() {
  const seedPath = path.join(process.cwd(), 'data', 'questionnaire-seed.json');
  const items = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));

  for (const item of items) {
    const malformed = MALFORMED_IDS.has(item.id);
    const { error } = await supabaseAdmin.from('questionnaire_items').upsert({
      id: item.id,
      question: item.question,
      category: item.category,
      priority: item.priority,
      answer_type: item.answer_type ?? 'text',
      status: malformed ? 'not_applicable' : 'unknown',
      answer: malformed ? 'Not applicable — malformed row in source questionnaire.' : null,
      evidence: [],
      conflicts: [],
      confidence: malformed ? 1 : 0,
      asked_user: false,
    });
    if (error) throw error;
    console.log(`Seeded: ${item.id}${malformed ? ' (malformed — marked not_applicable, skipping populate)' : ''}`);
  }

  console.log('\nRunning document-populate pass on all items...\n');
  for (const item of items) {
    if (MALFORMED_IDS.has(item.id)) continue;
    const result = await populateFromDocuments({ id: item.id, question: item.question, answer_type: item.answer_type } as any);
    console.log(`${item.id}: ${result.status} (confidence ${result.confidence})`);
  }
  console.log('\nDone. Check the questionnaire_items table in Supabase.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});