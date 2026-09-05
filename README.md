# Regodit AI Security Analyst

## Architecture

- **Supabase (Postgres + pgvector)** — single source of truth for two things:
  1. `documents`/`chunks` — your RAG corpus (embedded document sections)
  2. `questionnaire_items` — the knowledge base object itself: one row per question, with
     `status` (verified / conflicting / unknown / user_confirmed), `answer`, `evidence`,
     `conflicts`, `confidence`.
- **Next.js API routes** — `/api/chat` runs the conversation loop, `/api/questionnaire`
  serves the live dashboard state.
- **Claude (Anthropic SDK)** — used only to *propose* answers with citations; the app
  layer (`lib/llm.ts`) refuses to trust any citation that doesn't map to a real chunk id,
  and refuses "verified" status with zero evidence. That's the Golden Rule enforced in code,
  not just in a prompt.
- **Voyage AI** — embeddings (Anthropic's recommended provider, has a free tier).

## Setup

1. **Create a Supabase project** (free tier) → run `supabase/schema.sql` in the SQL editor.
2. Copy `.env.example` to `.env` and fill in:
   - `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (Project Settings > API)
   - `ANTHROPIC_API_KEY`
   - `VOYAGE_API_KEY` (https://dashboard.voyageai.com — free tier)
3. `npm install`
4. Pull your Google Drive docs down locally into `./raw-docs/` (any mix of .docx/.xlsx/.pdf).
5. `npm run ingest` — chunks + embeds every doc into Supabase.
6. `npm run seed` — loads the questionnaire items (`data/questionnaire-seed.json`) and runs
   the document-populate pass on all of them. Watch the console: you'll immediately see
   which items came back `verified`, `conflicting`, or `unknown` — this is your gap list.
7. `npm run dev` → http://localhost:3000

## Editing the questionnaire

Edit `data/questionnaire-seed.json` to match the actual vendor questionnaire from
`1. Sample_Vendor questionnaire` — add/remove items, tweak `priority` (lower = asked sooner).
Re-run `npm run seed` after changes (it upserts, safe to re-run).

## Adding PRISM tracing

Wrap the two decision points that matter most for judges — `analyzeQuestion` in
`lib/llm.ts` and `recordUserAnswer` in `lib/knowledgeBase.ts` — with `prismtrace-sdk`
so you have a visual trace of every verified/conflicting/unknown decision to show
during the demo (`pip install prismtrace-sdk` per PRISM's setup — if their SDK is
Python-first, you may need a small sidecar or their JS/HTTP tracing option; check
their docs for a Node integration path).

## What to demo

1. Show the dashboard mid-conversation with a mix of verified (green), conflicting
   (amber), and unknown (grey) items — this alone demonstrates "search before asking."
2. Walk through a conflicting item live (e.g. an access-control claim vs. a VAPT
   finding) — the bot should state the conflict explicitly rather than picking a side.
3. Answer a vague question ("yes") and show the follow-up firing (frequency/automation).
4. Correct something already `user_confirmed` and show it update in place, not duplicate.
5. Hit "generate questionnaire" (export from `/api/questionnaire`) and show the final
   three-tier breakdown: Verified / Confirmed by user / Unknown.
