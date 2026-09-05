# AI Security Analyst — Final Build Plan (2-hour scope)

**Read this whole doc before touching code.** It's the single source of truth for who
does what, when to commit, and what prompts to use. Paste it into your own Claude/Claude
Code session if you want help on your part specifically — say which role you own.

---

## 0. What we're building (one paragraph)

A chatbot that fills out a 66-question vendor security questionnaire by first searching
the company's own documents for answers, then asking the user only about what's missing
or contradictory — never guessing. Every answer shows its evidence. Conflicts between
sources are surfaced, never silently resolved. A live dashboard shows every question's
status (verified from docs / conflict / unknown / confirmed by user) and updates the
moment an answer is recorded.

**Golden Rule: the system never fabricates an answer.** Unknown is a correct output. A
confident wrong answer is a total failure. This overrides every other decision below.

---

## 1. Scope: what we're building vs. cutting

We started from a more ambitious spec (slot-based rubrics, dependency gates, a computed
confidence formula, hybrid retrieval). **That design needs ~20 hours. We have 2.** So:

**Keeping:**
- Flat knowledge base: one row per question (66 total), not slots
- Evidence citations on every answer
- Conflict detection between sources (policy vs. actual practice)
- Live-updating colored dashboard next to the chat
- Enforcement in code (not just prompting) that no answer is written without evidence
  or explicit user confirmation

**Cutting:**
- Slot decomposition (one question → many sub-facts)
- Dependency gates (one answer retiring several other questions)
- The computed confidence formula
- Hybrid BM25 + vector retrieval (plain vector search only)
- xlsx writeback with preserved formatting (on-screen table export is enough)

If you finish early, gates and confidence scoring are the first things to add back —
not before the core loop works end to end.

---

## 2. One-time setup (minutes 0–10, do this together, then split)

1. Unzip the provided scaffold into the repo root.
2. `git add . && git commit -m "scaffold" && git push` — this is everyone's starting point.
3. Create a free Supabase project → SQL Editor → paste and run `supabase/schema.sql`.
4. Copy `.env.example` → `.env`. Fill in:
   - `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API)
   - `ANTHROPIC_API_KEY` (console.anthropic.com)
   - `VOYAGE_API_KEY` (dashboard.voyageai.com, free tier)
5. Share `.env` values with the team over DM/Slack — **never commit `.env`**, it's gitignored.
6. Whoever owns ingestion starts pulling the Google Drive docs into `raw-docs/` now.

---

## 3. Git workflow — no big merge at the end

With 2 hours, a single end-of-session merge is the highest-risk thing you can do.
Instead:

- **No long-lived feature branches.** Everyone commits small changes directly to `main`
  every 15–20 minutes.
- **File ownership below is designed so people rarely touch the same file.** If you must
  edit a file someone else owns, say so in chat first.
- **Whoever touches `supabase/schema.sql` or an API response shape pushes immediately** —
  others are reading from that contract.
- At minute 90: everyone does `git pull`, runs the app together, and only fixes breakage
  from that point on — no new features.

---

## 4. Task assignment

### P1 — Ingestion & Data
**Owns:** `scripts/ingest.ts`, `scripts/seed-questionnaire.ts`, `raw-docs/`, `data/questionnaire-seed.json`

**Do:**
- [ ] Pull all docs from the Drive `Hackathon` folder into `raw-docs/` (keep original filenames)
- [ ] `npm install`
- [ ] `npm run ingest` — chunks + embeds every doc into Supabase
- [ ] `npm run seed` — loads all 66 questions, runs the populate pass against your docs
- [ ] Watch console output: this is your gap list (verified / conflicting / unknown per item)
- [ ] Add a one-line check in `seed-questionnaire.ts` to mark question **Q52** as
      `not_applicable` before seeding — its question text in the sheet is literally the
      string `"52"` (a malformed row), don't let it pollute retrieval

**Commit:** after first successful `ingest` run, again after `seed` completes.

---

### P2 — Backend / API (the integrator)
**Owns:** `lib/knowledgeBase.ts`, `app/api/*`, `supabase/schema.sql`

**Do:**
- [ ] Verify the API responds correctly once P1's data lands (`/api/questionnaire`, `/api/chat`)
- [ ] Fix breakages fast — P3 and P4 both depend on your response shapes
- [ ] If you change anything in `schema.sql` or an API response, push to `main` immediately

**Commit:** every time a schema or API shape changes — don't batch these.

---

### P3 — Conversation Prompts
**Owns:** `lib/llm.ts` only

**Do:**
- [ ] Tune the four functions already in the file: `analyzeQuestion`, `draftSessionOpener`,
      `draftConflictDialogue`, `needsFollowUp`
- [ ] You can iterate on these with a small standalone script hitting the Anthropic API
      directly — you don't need the full app running

**Prompt already wired in `draftConflictDialogue` — this is your demo centerpiece:**
```
Your Access Control Policy (Nov 2024) says MFA is mandatory for all systems. But
[message/infra source] suggests [contradiction]. [Source B] describes actual
configuration, so I'd lean toward [X] — but I don't want to decide for you. Which is
true today?
```
This is the highest-value thing to polish. It directly demonstrates the brief's own
example ("policy says MFA mandatory but a message suggests otherwise — don't blindly
answer yes").

**Session opener template already wired in `draftSessionOpener`:**
```
I've reviewed your uploaded documents against the 66-question security questionnaire.

Answered from your documents: {verified}.
Conflicts I need you to settle: {conflicting}.
Still unknown: {unknown}.

I'd suggest starting with the conflicts — they're blocking otherwise-complete answers.
```

**Commit:** every 15–20 min as you tune prompt text — these are cheap, low-conflict-risk edits.

---

### P4 — Frontend
**Owns:** `app/page.tsx`, `app/layout.tsx`

**Do:**
- [ ] It's functional already — spend your time on:
  1. Rendering the session-opener message distinctly (larger/highlighted first bubble)
  2. Cleaning up the evidence `<details>` blocks so sources are easy to scan
  3. A coverage header bar: `34 verified · 6 conflict · 20 unknown · 6 n/a`, computed
     from the `summary` object already returned by `/api/questionnaire`
- [ ] The coverage bar is your highest-leverage 15 minutes — it's judges' first visual impression

**Commit:** every 15–20 min as UI pieces land.

---

## 5. Timeline

| Time | What happens |
|---|---|
| 0–10 min | Setup together (Section 2) |
| 10–90 min | Parallel work, commit to `main` every 15–20 min |
| 90–105 min | Everyone `git pull`, run together, fix only what's broken — no new features |
| 105–115 min | Rehearse the demo script below, out loud, once |
| 115–120 min | Buffer |

---

## 6. Demo script (rehearse this exactly)

1. Show the dashboard mid-run: a mix of green (verified) / amber (conflict) / grey
   (unknown) nodes — "search before asking" is visible at a glance, no explanation needed.
2. Click into a conflicting item, read the conflict dialogue out loud (P3's prompt).
3. Answer a vague question ("yes"), show the follow-up firing on the missing detail
   (frequency/automation).
4. Correct something already confirmed, show it update in place — not duplicated.
5. Close on the number: **"X of 66 answered from documents alone, zero guesses — everything
   unknown says unknown."** This is your strongest line. It's literally the judges' own bar.

---

## 7. Non-negotiables — check before you call anything "done"

- [ ] No answer is ever written without either document evidence or explicit user confirmation
- [ ] A question that's already answered is never asked again
- [ ] Unknown renders as "Unknown — needs input", never as a guess
- [ ] Every document-derived answer shows its source
- [ ] The dashboard updates live as the conversation progresses, without a manual refresh
