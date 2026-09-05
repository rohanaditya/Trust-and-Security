# Stage 3 (Conversation Layer) — Status Handoff

Context: Regodit-track "AI Security Analyst" hackathon build. Team split into P1
(ingestion), P2 (backend/API), P3 (conversation layer — this doc), P4 (frontend), per
`PLAN.md`. Full target spec: `AI_SECURITY_ANALYST_SPEC.md`. Scaffold repo:
`regodit-security-analyst/`.

Originally scoped to `lib/llm.ts` only. Scope expanded mid-build once schema/route
changes were approved — see "Files touched" below.

---

## What's implemented

### `lib/llm.ts`
- `analyzeQuestion(question, chunks, answerType)` — ingest-time, per-item, doc-vs-doc
  conflict detection via one LLM call over retrieved chunks. Citation-enforcement layer
  unchanged from scaffold (never trusts a bare "verified" claim, discards unverifiable
  citations). Added:
  - `answerType` param (`boolean | text | document_request`) — boolean questions get a
    Yes/No-normalized answer instruction; `document_request` questions are told to
    verify a document *exists* rather than restate its contents.
  - Q52 short-circuit: if `question.trim() === '52.0'`, returns a clean resolved result
    with no retrieval/LLM call (the row is a malformed spreadsheet artifact, not a real
    question — see spec §2.2). Redundant with the seed-time fix below, kept as a
    belt-and-suspenders in case seeding is ever skipped.
- `draftSessionOpener(summary)` — unchanged from scaffold, already matched spec §7.2's
  template.
- `draftConflictDialogue(question, conflicts)` — prompt tightened to stop implying
  dates or source types that the data doesn't actually carry (`Conflict.sources` is
  filename strings only, no date field exists anywhere in this schema). Still the
  demo-centerpiece prompt per PLAN.md.
- `needsFollowUp(question, userAnswer, answerType)` — now takes real `answer_type` and
  skips the LLM call entirely for `boolean`/`document_request` (neither carries a hidden
  extra detail in this schema — cadence/process questions are always `text`-typed).
  Only `text`-type answers go through the vagueness-check LLM call.
- **New: `looksLikeCorrection(message)`** — cheap keyword trigger (no LLM cost), checks
  for phrases like "actually", "that's outdated", "we changed that", etc.
- **New: `detectCorrection(priorQuestion, priorAnswer, userMessage)`** — LLM call, only
  invoked when the keyword trigger fires. Confirms whether the message actually
  contradicts a prior confirmed answer (biased toward false=not-a-correction, since a
  false positive silently overwrites a confirmed answer). Returns `{is_correction,
  new_answer, message}`.

### `lib/types.ts`
- Added `AnswerType = 'boolean' | 'text' | 'document_request'`.
- Added `answer_type: AnswerType` to `QuestionnaireItem`.

### `supabase/schema.sql`
- Added `answer_type text not null default 'text' check (...)` column to
  `questionnaire_items`. Default keeps old rows valid without a forced migration.

### `scripts/seed-questionnaire.ts`
- Seeds real `answer_type` from `data/questionnaire-seed.json` (was previously silently
  dropped).
- Hardcodes Q52 (`id: "52_52_0"`) to `status: 'not_applicable'` at seed time and skips
  it in the populate pass entirely — never sent to retrieval or the LLM.

### `lib/knowledgeBase.ts`
- `populateFromDocuments` now passes `item.answer_type` into `analyzeQuestion`.
- **New: `getMostRecentlyConfirmedItem(excludeId?)`** — fetches the single most
  recently `user_confirmed` item, used only by correction detection.

### `app/api/chat/route.ts`
- `needsFollowUp` call now passes `item.answer_type`.
- **New correction branch**, inserted before the normal in-progress/fresh-turn logic:
  on a keyword hit (and only then), checks the message against the single most
  recently confirmed item via `detectCorrection`. If confirmed, calls
  `recordUserAnswer` on *that* item and returns early — without disturbing whatever
  `currentItemId`/`pendingFollowUp` was already in flight.

---

## Known, accepted gaps (deliberate, not oversights)

1. **Correction detection is scoped to one prior item, not full history.** It only
   checks the *most recently confirmed* item, not every settled answer in the session.
   A correction to something confirmed several turns ago, while a different item was
   answered in between, won't be caught. Full history-wide correction would need the
   session model extended (tracking all confirmed items per session, not just querying
   "most recent") — explicitly deferred.

2. **No category-picker, no harvest scanning.** The conversation loop is still strictly
   single-item (`nextItemToAsk()` returns one globally-ranked item at a time). A user
   volunteering an answer to a *different* question while answering the current one
   is never captured — full spec §7.4's "harvest volunteered facts" behavior. This was
   deliberately cut this round: it requires rearchitecting `nextItemToAsk` and the
   chat route's control flow, judged too risky this close to the demo. **First thing to
   add back post-hackathon.**

3. **Conflict detection is doc-vs-doc only, resolved at ingest time.** There's no
   `doc_hits`-style table of separate candidate answers for P3 to compare — the RAG
   retrieval + `analyzeQuestion` at ingest already resolves this into a single
   `status: conflicting` (or not) before conversation ever starts. This is actually
   fine / not a real gap — just noting it because earlier planning (before the scaffold
   was seen) assumed a different architecture.

4. **No document dates anywhere in the schema.** `documents` table has `created_at`
   (upload time) but no `authored_at`. `draftConflictDialogue`'s prompt was written to
   never claim a date it doesn't have — worth fixing at the schema level if there's
   time, since real document dates would meaningfully improve conflict resolution
   quality (recency bias per spec §3.5).

5. **`answer_type` requires a re-seed to take effect on existing rows.** The schema
   migration is additive/safe (`default 'text'`), but any row seeded before this change
   needs `npm run seed` re-run to get its real `answer_type` — otherwise it silently
   behaves as `'text'` (LLM-checked follow-up instead of skipped).

---

## Suggested next steps (in Claude Code)

1. Confirm the app boots clean after the schema/type changes (`npm run dev`, check for
   type errors — nothing here should require it, but hasn't been run through `tsc`
   directly in this session).
2. Re-run `npm run seed` if the corpus was already seeded before this change, so
   `answer_type` populates correctly.
3. Manually test: Q52 renders as resolved/not-applicable; a `text`-type question
   answered vaguely triggers a follow-up; a `boolean` question answered "yes"/"no" does
   NOT trigger a follow-up; saying "actually, we changed that" after confirming an
   answer correctly updates that specific item without derailing the current one.
4. If time allows post-demo: category-picker + harvest (item 2 above), and adding
   `authored_at` to `documents` (item 4 above) to unlock real recency-based conflict
   bias.
