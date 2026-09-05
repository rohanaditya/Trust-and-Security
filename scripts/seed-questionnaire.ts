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

async function main() {
  const seedPath = path.join(process.cwd(), 'data', 'questionnaire-seed.json');
  const items = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));

  for (const item of items) {
    const { error } = await supabaseAdmin.from('questionnaire_items').upsert({
      id: item.id,
      question: item.question,
      category: item.category,
      priority: item.priority,
      status: 'unknown',
      answer: null,
      evidence: [],
      conflicts: [],
      confidence: 0,
      asked_user: false,
    });
    if (error) throw error;
    console.log(`Seeded: ${item.id}`);
  }

  console.log('\nRunning document-populate pass on all items...\n');
  for (const item of items) {
    const result = await populateFromDocuments({ id: item.id, question: item.question } as any);
    console.log(`${item.id}: ${result.status} (confidence ${result.confidence})`);
  }
  console.log('\nDone. Check the questionnaire_items table in Supabase.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
