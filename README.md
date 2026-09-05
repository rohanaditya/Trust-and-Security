# Regodit AI Security Analyst

Vendor security questionnaires burn days of a security team's time — mostly re-typing
answers that already live in a policy doc somewhere. **Regodit AI Security Analyst** reads
your own documents first, answers what it can back up with a citation, and only asks a
human about what's missing or where two sources disagree. It never guesses: an
unanswered question stays "unknown" instead of becoming a confident wrong answer, and
when a policy contradicts actual practice, the system surfaces the conflict instead of
silently picking a side. The payoff is a live dashboard — verified from docs / conflict /
unknown / confirmed by you — that turns a 66-question audit slog into a focused review of
just the gaps.

---

## Problem statement

Enterprise customers send vendors 60–70 question security questionnaires before signing
a contract. The answers already exist — scattered across policy documents, infra
configs, contracts, pentest reports, and Slack threads — but someone still has to read
all of it and manually transcribe the answers, question by question. Two things make
this worse than plain busywork:

- **The material is incomplete and contradictory.** A policy might say MFA is mandatory
  everywhere while an infra config or a Slack message shows it isn't actually enforced
  on one system. Picking one source silently and moving on is how false statements end
  up in a signed compliance document.
- **A gap is invisible until someone notices it's missing.** If no document mentions
  background checks, nothing naturally "flags" that absence — it just gets skipped, or
  worse, guessed at.

A generic LLM chatbot pointed at a folder of documents will happily produce a fluent,
confident, wrong answer to a question its corpus never actually addressed. For a
compliance document, that's a worse outcome than leaving the field blank.

## Our solution

A conversational analyst that treats the questionnaire itself as the source of truth for
*what needs to be known*, not the documents. Every one of the 66 questions starts in an
explicit `unknown` state. A retrieval pass then searches the company's own document
corpus for evidence and tries to answer each question **only when it can cite a specific
chunk of source text** — never from the model's general knowledge. Any question that the
documents can't settle, or where two documents disagree, is escalated to a short,
targeted conversation with a human — never inferred silently.

This flips the usual chatbot failure mode: instead of an LLM that always has an answer,
this system is designed so that "I don't know, can you tell me?" and "your policy and
your Slack message disagree, which is correct?" are first-class, expected outputs.

## Key features

- **Search-before-ask.** Every question is checked against the document corpus before
  the user is ever prompted — the user only answers what genuinely isn't documented.
- **Evidence-gated answers.** The app layer (not just the prompt) refuses to mark a
  question `verified` unless the model's cited chunk IDs actually resolve to real
  retrieved chunks. No citation, no verified status — enforced in code.
- **Multi-source conflict detection.** Each document-derived candidate answer is stored
  as its own `doc_hits` row rather than being collapsed into one field. When two
  documents produce different values for the same question, the system flags a conflict
  and asks the user to settle it explicitly, rather than picking a side.
- **Six-state status model**, computed deterministically from stored evidence (no extra
  LLM calls to derive it): `unknown → vague → verified → confirmed / conflict →
  not_applicable`.
- **Distinct correction path.** Fixing an already-`confirmed` answer is a separate,
  explicit write path from recording a first answer — corrections don't get silently
  merged into the evidence trail that produced the original value.
- **Live dashboard.** A colored knowledge-base panel updates the moment an answer is
  recorded — no manual refresh — so "search before asking" is visible at a glance instead
  of requiring an explanation.
- **Follow-up on vague answers.** A one-word "yes" to a control question triggers a
  targeted follow-up (e.g. frequency, automation) instead of being accepted as complete.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 14 (App Router) + React, inline styles | Single deployable, fast to iterate on in a hackathon window |
| Backend | Next.js API routes (`/api/*`) | Same repo/deploy as the frontend, no separate service to stand up |
| Database | Supabase (Postgres) | Managed Postgres with instant REST/JS client, generous free tier |
| Vector search | pgvector (via Supabase) | Vector similarity search lives next to the relational data — one database, no separate vector service |
| LLM | Claude (Anthropic SDK) | Used only to *propose* candidate answers and drafts — every proposal is validated against real evidence before it's trusted |
| Embeddings | Voyage AI | Anthropic's recommended embedding provider, free tier |
| Document parsing | `mammoth` (.docx), `xlsx`, `pdf-parse` | Covers the real-world mix of formats a security team's document folder actually contains |

## How it works

```
raw-docs/ (.docx / .xlsx / .pdf)
        │  npm run ingest
        ▼
  documents + chunks (embedded, in Supabase/pgvector)
        │
        │  npm run seed  →  loads 66 questionnaire_items, each starts `unknown`
        ▼
  populate pass (per question):
    1. vector-search the corpus for relevant chunks
    2. ask Claude to propose an answer, citing chunk IDs only
    3. app layer verifies every cited ID against real retrieved chunks
    4. write one doc_hits row per supporting/conflicting chunk (not one flat answer)
    5. recompute status deterministically from doc_hits:
         0 hits           → unknown
         1 distinct value → verified (or vague, below a confidence bar)
         >1 distinct value → conflict
        ▼
  /api/chat conversation loop:
    - opens with a summary of what documents already answered
    - walks unknown/vague/conflict items in priority order
    - "vague" answers trigger a targeted follow-up question
    - "conflict" items are put to the user as an explicit either/or, never auto-resolved
    - a normal answer → status: confirmed
    - an explicit correction to an already-confirmed answer → separate write path
        ▼
  /api/questionnaire (?filter=open | ?filter=settled)
        │
        ▼
  live dashboard (app/page.tsx): colored status per question, coverage bar, evidence
  drill-down — updates immediately after every chat turn, no refresh
```

The **Golden Rule** governing every one of these steps: the system never fabricates an
answer. `unknown` is a correct, shippable output; a confident wrong answer is treated as
a total failure of the product, not an edge case to tolerate.

## How to run it

1. **Create a Supabase project** (free tier) → SQL Editor → run `supabase/schema.sql`.
2. Copy `.env.example` to `.env` and fill in:
   - `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API)
   - `ANTHROPIC_API_KEY`
   - `VOYAGE_API_KEY` (https://dashboard.voyageai.com — free tier)
3. `npm install`
4. Drop your source documents (any mix of `.docx` / `.xlsx` / `.pdf`) into `./raw-docs/`.
5. `npm run ingest` — chunks + embeds every document into Supabase.
6. `npm run seed` — loads the 66 questionnaire items (`data/questionnaire-seed.json`) and
   runs the document-populate pass on all of them. Watch the console: you'll immediately
   see which items came back `verified`, `conflict`, or `unknown` — this is your gap list.
7. `npm run dev` → http://localhost:3000 and start the conversation.

To adapt this to a different questionnaire, edit `data/questionnaire-seed.json` (add/
remove items, tweak `priority` — lower is asked sooner) and re-run `npm run seed`; it
upserts, so it's safe to re-run after changes.

## What to demo

1. Show the dashboard mid-conversation with a mix of verified (green), conflict (amber),
   and unknown (grey) items — this alone demonstrates "search before asking" without any
   explanation needed.
2. Walk through a conflict item live (e.g. an access-control policy claim vs. an actual
   infra config or Slack message) — the bot states the conflict explicitly and asks the
   user to settle it, rather than picking a side.
3. Answer a vague question ("yes") and show the follow-up firing on the missing detail
   (frequency/automation).
4. Correct something already `confirmed` and show it update in place — not duplicated,
   and not silently blended into the original document evidence.
5. Close on the number: **"X of 66 answered from documents alone, zero guesses —
   everything unknown says unknown."**

## Scope notes for judges

This build deliberately cuts scope from a more ambitious design (see
`AI_SECURITY_ANALYST_SPEC.md` for the full original spec — slot-based sub-claim
decomposition, dependency gates between questions, a computed confidence formula, hybrid
BM25 + vector retrieval) in favor of shipping a complete, working loop in the hackathon's
time budget: one flat row per question, plain vector search, and a straightforward
confidence threshold instead of a full scoring model. `PLAN.md` documents the full task
breakdown and the reasoning behind each cut. None of the cuts touch the Golden Rule —
every cut trades sophistication for simplicity, not correctness.
