# AI Security Analyst — Build Specification

**Regodit Track · Hackathon build spec for a 4-person team**

This document is the single source of truth for the system. Every teammate works from
the same contracts defined in Part 1. Read Part 1 in full before starting your stage —
it is not optional context, it is the interface you are building against.

Paste this whole file into your own Claude conversation when you start work, then say
which stage you own.

---

## 0. What we are building, in one paragraph

An enterprise customer sends a 66-question vendor security questionnaire. The answers
are scattered across the company's policy docs, infrastructure configs, contracts,
assessments, and Slack messages — incomplete, ambiguous, and sometimes contradictory.
We build a system that (a) decomposes the questionnaire into atomic verifiable
sub-claims, (b) mines the company corpus for evidence and binds it to those sub-claims,
(c) detects contradictions between sources, (d) runs a conversation with a company
employee to fill only the genuine gaps, and (e) renders a completed questionnaire where
every answer carries its provenance and a status of *verified from documents*,
*confirmed by user*, *unknown*, or *not applicable*.

**The Golden Rule, which overrides every other consideration in this build: the system
never fabricates an answer.** Unknown is a correct, shippable output. A confident wrong
answer is a total failure of the product. Every design decision below descends from
this.

---

## 1. Core architecture (READ THIS PART EVEN IF YOU ONLY OWN THE FRONTEND)

### 1.1 The central insight

The questionnaire is the **spine** of the system, not the output at the end.

A naive design derives its knowledge structure from the documents. That design fails on
the single most important requirement in the brief: if the company has no document about
employee background checks, a document-derived structure never creates a "background
checks" node, so nothing ever flags it, so nobody ever asks. **The gap is invisible
precisely because it is a gap.**

So: the claim graph is seeded from the questionnaire the moment the account is created.
Every sub-claim exists in `unknown` state before any document is uploaded. Document
ingestion is a process that *attaches evidence to pre-existing nodes*. The screen is
full of grey nodes on day zero, and lights up as evidence arrives.

### 1.2 Three-tier graph

```
Tier 1: THEME            (14 of them, from the questionnaire's Topic rows)
           │
           ├── Tier 2: SUB-CLAIM NODE   (~70 after merging; the rubrics)
           │              │
           │              ├── slot: performed      ← Tier 3 evidence
           │              ├── slot: cadence        ← Tier 3 evidence
           │              └── slot: tooling        ← (empty = vague)
```

**Tier 3 is evidence**: one node per document, or per extracted span for long documents.
Edges run evidence → slot.

**Nodes are NOT one-per-policy-document.** This is the second most common design error
after 1.1. The mapping is many-to-many in both directions: one access-control policy
feeds Q56, 57, 58, 59, 60, 62 across two themes; conversely the backup node draws from a
BC/DR policy, an infra config, and a Slack thread. If policies were the nodes, the
question "what is still missing for Q59" would have nowhere to live.

The document-centric view is still useful as a **secondary lens** in the UI ("which
questions does this document support") and it directly answers the Vendor Profile tab's
"can you provide the following documentation" checklist.

### 1.3 The two write paths

There are exactly **two** ways information enters the ledger:

1. **Document ingestion** (Stage 1)
2. **User utterance during conversation** (Stage 3)

Both go through the *same* extract → validate → bind machinery. This is deliberate and
non-negotiable. Keeping it single is what makes conflict detection, provenance, and
correction handling consistent instead of three subtly different implementations. If you
find yourself writing a second binder, stop and talk to the Stage 2 owner.

### 1.4 System diagram

```
  questionnaire.xlsx
        │
        ▼ (offline, once)
  ┌──────────────┐
  │ RUBRIC CONFIG│  static JSON, checked into the repo
  └──────┬───────┘
         │ seeds
         ▼
  ┌─────────────────────────────────────────────┐
  │              THE LEDGER                     │  ← Stage 2 owns
  │  append-only claim entries + provenance     │
  └───┬──────────────┬───────────────┬──────────┘
      │              │               │
   writes         reads/writes     reads
      │              │               │
  ┌───┴────┐   ┌─────┴──────┐  ┌─────┴──────┐
  │INGEST  │   │CONVERSATION│  │  RENDER    │
  │Stage 1 │   │  Stage 3   │  │  Stage 4   │
  └────────┘   └────────────┘  └────────────┘
                                (+ graph viz, chat UI)
```

---

## 2. The questionnaire (ground truth)

Source file: `Regodit_Comprehensive_Vendor_Security_Questionnaire_Clean.xlsx`

Three sheets:

| Sheet | Contents | Who cares |
|---|---|---|
| `Vendor Instructions` | Prose instructions | Nobody, skip |
| `Vendor Profile` | Company metadata, 3rd-party attestations checklist, documentation-provision checklist (8 items), scope-of-access checkboxes, AI-usage questions, computed "Next Steps" | Stage 1 (doc checklist), Stage 4 (render) |
| `Vendor Security Responses` | 66 numbered questions grouped under 14 `Topic` rows. Columns: Question ID, Security Question, **Vendor Response**, **Comments / Clarification**, **Source of information / Evidence** | Everyone |

**Note the third response column: the questionnaire itself demands provenance.** Our
ledger maps 1:1 onto the deliverable. This is a gift — use it.

### 2.1 The 14 themes and their question ranges

| # | Theme key | Display name | Qs |
|---|---|---|---|
| 1 | `governance` | Governance | 1–5 |
| 2 | `third_party_risk` | Third-Party Risk Management | 6–10 |
| 3 | `training` | Security Awareness & Training | 11–13 |
| 4 | `privacy` | Privacy | 14–18 |
| 5 | `data_security` | Data Security | 19–24 |
| 6 | `physical_security` | Physical Security | 25–29 |
| 7 | `web_app_security` | Web Application Security | 30–35 |
| 8 | `secure_coding` | Secure Coding | 36–37 |
| 9 | `vulnerability_mgmt` | Vulnerability Management | 38–40 |
| 10 | `bcdr` | Business Continuity & Disaster Recovery | 41–42 |
| 11 | `incident_response` | Incident Response | 43–49 |
| 12 | `network_endpoint` | Network & Endpoint Security | 50–54 |
| 13 | `asset_management` | Asset Management | 55–62 |
| 14 | `risk_assessment` | Risk Assessment | 63–66 |

### 2.2 Known quirks in the source file — handle these

- **Q52 is blank.** Its question text is literally the string `"52"`. Detect and mark
  `malformed: true` in the config; render as not-applicable with a comment. Do not
  hallucinate a question for it. (This is a good demo talking point — the system
  noticed the questionnaire itself was broken.)
- **Conditional gates.** Several questions only apply based on an earlier answer:
  - Q30 (*Will Client XYZ be using a web application provided by you?*) gates Q31–35
  - Q6 (*Will you be using contractors or sub-contractors?*) gates parts of Q7–10
  - Q15 (*sensitive data access?*) affects the weight of Q16–18
  - Q26 (*require physical access to Client sites?*) gates Q27–28
  - Q51 (*accessing Client's network?*) gates Q53–54
  - Q48 (*security event in last 5 years?*) gates a follow-up detail sub-claim
  - Q65 (*penetration testing?*) gates Q66 (*findings remediated?*)
  - Vendor Profile's "Next Steps" gates whether the whole Security Responses tab applies
- **Dropdown-typed questions.** Q46 (IR plan test frequency) and Q59 (access review
  cadence) are dropdowns in the spreadsheet. Their slot enums must be copied **verbatim**
  from the sheet's data-validation lists so the rendered output is a legal value, not
  prose. Stage 1 owner: extract these during config generation.
- **Attachment questions.** Q8, Q16, Q17, Q24, Q29, Q42, Q54 ask for documents rather
  than prose. These are satisfied when a provenance entry of `source_type: document`
  with the right doc-class binds to the node. Do not try to answer them in prose.
- **Free-text questions that hide multiple sub-claims.** Q41 ("What is the process for
  disaster recovery and backups?") is one spreadsheet row but at least seven facts. This
  is exactly what the rubric decomposition is for.

---

## 3. SHARED SCHEMAS — the contracts

**Every field name here is normative.** Do not rename anything. If you need a new field,
raise it with the team and update this document; do not add it locally.

### 3.1 Rubric config (static, generated offline in Stage 1)

One file: `config/rubrics.json`. Array of rubric objects.

```jsonc
{
  "id": "vuln_scanning",                    // stable snake_case key, unique
  "theme": "vulnerability_mgmt",            // must match a theme key from §2.1
  "question_ids": [38, 39],                 // spreadsheet rows this rubric answers
  "claim": "Internal vulnerability scans are performed on a defined cadence",
  "importance": "high",                     // high | medium | low
  "answer_type": "composite",               // bool | enum | free_text | attachment | composite
  "depends_on": null,                       // or { "rubric_id": "web_app_exists", "slot": "exists", "equals": true }
  "malformed": false,                       // true only for Q52-style broken rows
  "slots": [
    {
      "name": "performed",
      "type": "bool",
      "required": true,
      "prompt": "Are internal vulnerability scans performed?",
      "aliases": ["vulnerability scan", "vuln scan", "scanning", "Nessus", "Qualys"]
    },
    {
      "name": "scope",
      "type": "enum",
      "enum": ["internal", "external", "both"],
      "required": true,
      "prompt": "Do those scans cover internal systems, external-facing systems, or both?"
    },
    {
      "name": "cadence",
      "type": "enum",
      "enum": ["continuous", "weekly", "monthly", "quarterly", "annually", "ad_hoc"],
      "required": true,
      "prompt": "How often are they run?"
    },
    {
      "name": "tooling",
      "type": "text",
      "required": false,
      "prompt": "Which tool do you use?"
    }
  ],
  "vagueness_rules": [
    "any required slot is empty",
    "cadence == 'ad_hoc' and no justification text present"
  ],
  "sufficiency": "all required slots filled, each with >=1 provenance entry, no open conflict",
  "render_template": "Yes — {scope} vulnerability scans are performed {cadence}{, using {tooling}}."
}
```

**Slot `type` vocabulary** (closed set — do not invent more):

| type | notes |
|---|---|
| `bool` | true / false |
| `enum` | requires `enum` array; values are the ONLY legal values |
| `text` | short free text |
| `duration` | normalized to ISO-8601-ish string: `"P30D"`, `"P24H"` |
| `date` | ISO date |
| `list` | array of strings |
| `attachment` | satisfied by a bound document, value is the doc id |

### 3.2 Ledger entry (runtime, append-only)

```jsonc
{
  "entry_id": "uuid",
  "company_id": "uuid",
  "rubric_id": "vuln_scanning",
  "slot": "cadence",
  "value": "quarterly",
  "confidence": 0.82,                     // DERIVED, see §3.6 — never LLM-self-reported
  "source": {
    "kind": "document",                   // document | user | inference_gate
    "source_id": "doc_042",
    "source_type": "policy",              // policy | assessment | contract | infra | message | user
    "span": "Internal vulnerability scans shall be conducted no less than quarterly.",
    "locator": { "page": 4, "char_start": 1201, "char_end": 1276 },
    "authored_at": "2024-11-03",
    "speaker": null                       // user email when kind == user
  },
  "created_at": "2026-09-05T14:22:10Z",
  "superseded_by": null,                  // entry_id of the entry that replaced this
  "supersede_reason": null                // "user_correction" | "newer_evidence" | "conflict_resolution"
}
```

**Append-only with supersession.** Never delete, never overwrite. This gives you
corrections, audit trail, and "what did we think before" for free. The *current* value
of a slot is the newest non-superseded entry.

### 3.3 Node state (derived, recomputed by the review pass)

```jsonc
{
  "rubric_id": "vuln_scanning",
  "state": "vague",
  "filled_slots": ["performed", "scope"],
  "empty_required_slots": ["cadence"],
  "conflicts": [ /* see §3.4 */ ],
  "confidence": 0.61,
  "provenance_count": 3,
  "last_touched": "2026-09-05T14:22:10Z",
  "attempted_and_unknown": false          // user said "I don't know"
}
```

**State enum (closed set):**

| state | meaning | UI colour |
|---|---|---|
| `unknown` | no evidence at all | grey |
| `not_applicable` | gate evaluated false | dimmed / hatched |
| `pending_gate` | gate not yet evaluated | dimmed outline |
| `vague` | some but not all required slots filled | amber |
| `conflicted` | two sources disagree, unresolved | red |
| `verified` | complete, all provenance from documents | green |
| `user_confirmed` | complete, at least one slot from the user | blue |
| `attempted_unknown` | asked, user could not answer | grey with dot |

Precedence when several could apply: `conflicted` > `pending_gate` > `not_applicable` >
`vague` > `user_confirmed` > `verified` > `attempted_unknown` > `unknown`.

### 3.4 Conflict object

```jsonc
{
  "conflict_id": "uuid",
  "rubric_id": "mfa",
  "slot": "coverage",
  "kind": "policy_vs_practice",           // see below
  "entries": ["entry_uuid_a", "entry_uuid_b"],
  "summary": "Policy mandates MFA on all systems; a March 2026 Slack thread indicates contractor accounts are exempt.",
  "resolution_question": "Your access control policy requires MFA everywhere, but a message from March suggests contractor GitHub accounts don't have it enforced. Which is currently true?",
  "status": "open",                       // open | resolved | dismissed
  "resolved_by_entry": null
}
```

**Conflict kinds** — classify, because the resolution differs:

| kind | example | resolution bias |
|---|---|---|
| `policy_vs_practice` | policy says MFA mandatory, Slack says Bob's exempt | practice wins for "is it enforced"; ask user |
| `stale_vs_current` | 2023 policy says quarterly, 2026 config shows monthly | recency wins, but confirm |
| `source_disagreement` | two docs of equal authority disagree | must ask user |
| `user_vs_document` | user says X, doc says Y | user wins but record both; supersede_reason = user_correction |
| `scope_ambiguity` | doc covers prod only, question asks about all systems | ask for scope clarification |

**Never auto-resolve silently.** The system may *rank* the sides by authority/recency and
present a recommendation, but the resolution is always recorded as a user decision or
left open.

### 3.5 Source authority (used in confidence and conflict ranking)

Maps directly onto the provided folder structure:

| Folder | `source_type` | Authority for *stated intent* | Authority for *actual practice* |
|---|---|---|---|
| `2. Company policies` | `policy` | 1.0 | 0.6 |
| `3. Security Assessment...` | `assessment` | 0.9 | 0.85 |
| `4. Contracts_agreements` | `contract` | 0.85 | 0.5 |
| `5. Infrastructure_internal...` | `infra` | 0.5 | **1.0** |
| (Slack / internal messages) | `message` | 0.3 | 0.8 |
| Conversation | `user` | 0.95 | 0.95 |

The split matters. Most questionnaire questions secretly mean "is this *enforced*", not
"is this *written down*". A policy is strong evidence of intent and weak evidence of
practice; an infra config is the reverse. This table is why `policy_vs_practice` is the
most common conflict kind you will see.

### 3.6 Confidence — derived, never asked for

Do **not** ask an LLM "how confident are you". Self-reported confidence is noise. Compute:

```
base        = max(authority[source_type] for entries on this slot)
corroborate = min(0.15, 0.05 * (independent_agreeing_sources - 1))
recency     = -0.10 if newest supporting entry older than 18 months else 0
userconf    = +0.10 if any entry has kind == "user"
conflict    = -0.40 if an open conflict touches this slot

slot_confidence = clamp(base + corroborate + recency + userconf + conflict, 0.05, 0.99)
node_confidence = min(slot_confidence for required slots)
```

Node confidence is a **min**, not a mean — a node is only as trustworthy as its weakest
required slot. This is explainable in the UI, which matters because judges will poke at it.

### 3.7 API contract (Stage 2 serves, Stages 3 and 4 consume)

```
POST   /api/company                          → { company_id }            create + seed ledger
POST   /api/company/:id/documents            → { ingestion_job_id }      upload (multipart)
GET    /api/company/:id/ingestion/:job_id    → { status, progress, errors[] }

GET    /api/company/:id/graph                → { themes[], nodes[], evidence[], conflicts[] }
GET    /api/company/:id/node/:rubric_id      → full node + all entries + provenance spans
GET    /api/company/:id/queue                → ranked work queue (§4.3)
GET    /api/company/:id/stats                → { total, verified, user_confirmed, vague, conflicted, unknown, na }

POST   /api/company/:id/session              → { session_id, brief }     opens a chat session
POST   /api/session/:sid/message             → { reply, ledger_delta[], graph_delta[] }
POST   /api/session/:sid/theme               → { theme_key }             user picks a theme
POST   /api/company/:id/correction           → { rubric_id, slot, value } explicit user correction
POST   /api/conflict/:cid/resolve            → { winning_entry_id, note }

GET    /api/company/:id/questionnaire        → JSON render (§7.2)
GET    /api/company/:id/questionnaire.xlsx   → filled workbook download
```

**`ledger_delta` and `graph_delta`** are the key to a live UI. Every message response
returns exactly what changed, so the frontend animates nodes rather than refetching the
whole graph. Shape:

```jsonc
"graph_delta": [
  { "rubric_id": "backups", "old_state": "vague", "new_state": "user_confirmed",
    "slots_filled": ["frequency", "automated"], "confidence": 0.88 }
]
```

---

## 4. Behavioural rules that everyone must respect

### 4.1 The Golden Rule, operationalised

1. Every ledger entry must carry a `span` that **verbatim exists** in its source. Stage 1
   and Stage 3 both validate this with a substring check before writing. A failed check
   means the extractor hallucinated: discard the entry and log it.
2. No slot may be filled by inference across nodes. "They have SOC 2, so they probably do
   annual pen tests" is forbidden. SOC 2 evidence binds to the attestation slot only.
3. An LLM may never write directly to the ledger. It proposes candidate facts; the binder
   validates and writes.
4. Rendering an `unknown` is always allowed and never a failure.

### 4.2 Vagueness is a rule, not a vibe

"Vague" = one or more required slots empty, or a rubric-specific rule fires. It is
**computed**, not judged by an LLM. This gives you one definition consumed by three
things: the review pass, the follow-up question generator, and the UI highlight. Same
rule, three consumers, zero drift.

### 4.3 Queue ranking

```
priority = importance_weight × (empty_required_slots / total_required_slots)
           × theme_multiplier
           + conflict_bonus            (+100 if node has an open conflict)
           - attempted_penalty         (-50 if attempted_and_unknown)
```

`importance_weight`: high=10, medium=5, low=2. `theme_multiplier` boosts themes an
enterprise buyer actually blocks on — data security, asset management (access control),
incident response, vulnerability management — over visitor logs.

Skip `not_applicable` and `pending_gate` nodes entirely.

### 4.4 Gates resolve before their dependents are ever surfaced

If Q30 is answered "no web app", Q31–35 flip to `not_applicable` and never enter the
queue. Ask gate questions early — one answer can retire five nodes. In the UI, show them
as hatched-out, not as gaps: the difference between "we have nothing on SSO" and "SSO
does not apply to this vendor" is the whole point.

---

## 5. STAGE 1 — Rubric generation + corpus ingestion

**Owner: 1 person. This is the foundation; start immediately, others are blocked on your
config file.**

### 5.1 Deliverables

| # | Deliverable | Consumed by |
|---|---|---|
| 1.1 | `config/rubrics.json` — ~70 rubrics covering all 66 questions + Vendor Profile | everyone |
| 1.2 | `config/themes.json` — theme keys, display names, multipliers | Stage 2, 4 |
| 1.3 | Document loader + chunker with source-type metadata | Stage 2 |
| 1.4 | Fact extractor (LLM) producing candidate facts with verbatim spans | Stage 2 |
| 1.5 | Span validator (substring check, hard reject on fail) | Stage 2, 3 |
| 1.6 | Binder: candidate fact → (rubric_id, slot) with confidence | Stage 2, 3 |
| 1.7 | Ingestion orchestrator + progress reporting | Stage 2 |
| 1.8 | Eval corpus with planted defects | everyone |

### 5.2 Rubric generation (do this FIRST, ship the JSON within hours)

Do not hand-write 70 rubrics. Process:

1. Parse the xlsx with `openpyxl`. Pull question id, text, topic grouping, and — crucially
   — the **data-validation dropdown lists** for Q46 and Q59 (`ws.data_validations`).
2. LLM pass: for each question, draft a rubric per §3.1. Prompt it with 3 hand-written
   gold examples (MFA, backups, vuln scanning — given in §5.3) so the output shape is
   consistent.
3. Post-process: merge rubrics that share a claim (38+39 → `vuln_scanning`; the Q56–62
   access cluster → roughly `identity_access_controls`, `rbac`, `access_reviews`,
   `mfa`, `least_privilege`). Assign `depends_on` for the gates listed in §2.2. Flag Q52
   `malformed`.
4. **Hand-correct the top 15.** These are the ones judges will probe: MFA (60/61),
   encryption at rest (20), in transit (21), data location (19/22), backups + DR (41/42),
   vuln scanning (38/39/40), access reviews (58/59), least privilege (62), offboarding,
   incident response plan (45/46), security events history (48), pen testing (65/66),
   training cadence (11/12/13), data retention (23), RBAC (57). Get their slots exactly
   right; everything else can be LLM-quality.
5. Commit as a static file. **The config is not generated at runtime.** Determinism is
   worth more than flexibility here — your demo must behave identically every run.

### 5.3 Gold rubric examples (copy these shapes)

**MFA** — the node most likely to demo the conflict feature:

```jsonc
{
  "id": "mfa",
  "theme": "asset_management",
  "question_ids": [60, 61],
  "claim": "Replay-resistant multi-factor authentication is required for access to company systems",
  "importance": "high",
  "answer_type": "composite",
  "slots": [
    { "name": "required", "type": "bool", "required": true,
      "prompt": "Is MFA or OTP required for access to your systems?" },
    { "name": "mechanism", "type": "list", "required": true,
      "enum_hint": ["TOTP app", "SMS", "hardware key", "push", "WebAuthn"],
      "prompt": "What second factor do you use?" },
    { "name": "coverage", "type": "list", "required": true,
      "prompt": "Which systems does it cover — email, code hosting, cloud console, VPN?" },
    { "name": "enforcement", "type": "enum", "enum": ["enforced_technically", "policy_only", "optional"],
      "required": true,
      "prompt": "Is it enforced by configuration, or is it policy that people are expected to follow?" },
    { "name": "exceptions", "type": "list", "required": false, "default": [],
      "prompt": "Are there any accounts or user groups exempt from MFA?" },
    { "name": "nist_compliant", "type": "bool", "required": false,
      "prompt": "Are the authenticators NIST 800-63B compliant?" }
  ],
  "vagueness_rules": [
    "any required slot empty",
    "enforcement == 'policy_only' and exceptions is empty  // suspicious: unenforced policy with no known gaps"
  ],
  "sufficiency": "required slots filled with provenance and no open conflict"
}
```

The `exceptions` slot is where the headline conflict lives. A policy doc fills
`required: true`; a Slack message saying "contractor accounts still don't have MFA on
GitHub" writes to `exceptions` and flips the node to `conflicted`. Build for this case
explicitly — it is the brief's own example.

**Backups / DR** — one spreadsheet row (Q41), seven facts:

```jsonc
{
  "id": "backup_dr",
  "theme": "bcdr",
  "question_ids": [41, 42],
  "claim": "Data is backed up on a defined schedule and recoverable per a documented DR plan",
  "importance": "high",
  "answer_type": "composite",
  "slots": [
    { "name": "backups_exist",   "type": "bool",     "required": true },
    { "name": "frequency",       "type": "enum", "required": true,
      "enum": ["continuous", "hourly", "daily", "weekly", "monthly", "ad_hoc"] },
    { "name": "automated",       "type": "bool",     "required": true },
    { "name": "retention_period","type": "duration", "required": true },
    { "name": "offsite_or_cross_region", "type": "bool", "required": true },
    { "name": "restore_tested",  "type": "bool",     "required": true },
    { "name": "restore_test_date","type": "date",    "required": false },
    { "name": "rto",             "type": "duration", "required": false },
    { "name": "rpo",             "type": "duration", "required": false },
    { "name": "dr_plan_documented", "type": "attachment", "required": true }
  ],
  "vagueness_rules": [
    "any required slot empty",
    "restore_tested == true and restore_test_date is empty",
    "backups_exist == true and offsite_or_cross_region is empty"
  ]
}
```

This is the rubric that produces the brief's exemplar dialogue: *Do you perform backups?
→ Yes. → How frequently? → Daily. → Are they automated? → Yes.* Three turns, three slots,
driven mechanically by which slots are empty.

**Remediation SLAs** — catches the "we patch quickly" non-answer:

```jsonc
{
  "id": "patch_remediation_sla",
  "theme": "vulnerability_mgmt",
  "question_ids": [40],
  "claim": "Documented remediation timelines exist for critical and high severity findings",
  "importance": "high",
  "answer_type": "composite",
  "slots": [
    { "name": "documented",   "type": "bool",     "required": true },
    { "name": "critical_sla", "type": "duration", "required": true },
    { "name": "high_sla",     "type": "duration", "required": true },
    { "name": "tracking_system", "type": "text",  "required": false }
  ],
  "vagueness_rules": ["documented == true and (critical_sla empty or high_sla empty)"]
}
```

### 5.4 Ingestion pipeline

```
file → loader → chunker → extractor → span validator → binder → ledger writes
                   │                                       │
              source_type                            gate resolution
              from folder                            (may flip nodes to N/A)
```

**Loader.** Handle pdf, docx, xlsx, txt/md, and message exports (json/csv). Use the
`pdf-reading` and `docx` skills. Preserve page/line locators — the UI shows spans, so
you need to point back at them.

**Chunker.** ~800 tokens with ~150 overlap, but **respect structure**: split policy docs
on headings, never mid-clause. Split message exports per thread, not per message —
context lives across the thread. Attach metadata to every chunk:

```jsonc
{ "doc_id", "chunk_id", "source_type", "doc_title", "authored_at", "author", "page", "text" }
```

Dates matter enormously for `stale_vs_current` conflicts. Pull them from document
metadata, headers ("Last reviewed: March 2024"), and message timestamps. If you cannot
find a date, record `null` — do not guess one.

**Retrieval.** Hybrid: BM25 + dense embeddings, reciprocal-rank fusion. Pure vector
search fails here because security terms are exact — "MFA", "SOC 2", "AES-256", bucket
names — and embeddings cheerfully conflate "backup policy" with "backup of the policy
document". Use the rubric's slot `aliases` as query expansion terms.

**Extractor.** Per (chunk, candidate rubric) pair, ask the LLM to emit zero or more:

```jsonc
{ "rubric_id", "slot", "value", "span", "reasoning" }
```

Prompt requirements: the `span` must be copied character-for-character from the chunk;
emit nothing rather than guess; a chunk that merely mentions the topic without stating a
fact yields zero facts. Temperature 0.

**Span validator.** `if span not in chunk.text: reject and log`. This one substring check
is your primary defense for the Golden Rule and costs nothing. Track the rejection rate —
it is a genuinely interesting metric for the demo.

**Binder.** Type-coerce `value` to the slot's declared type; enum values must match the
enum exactly (use fuzzy match to the closest legal value, reject if no match above
threshold). Then check the slot's existing state and take one of four actions:

| existing | action |
|---|---|
| empty | write entry, state → `evidence_found` (or `verified` if node now complete) |
| agrees | write corroborating entry, confidence up |
| disagrees | write entry AND create conflict object, state → `conflicted`, nothing overwritten |
| slot is a gate | write, then run gate resolution across dependent nodes |

### 5.5 The two-pass ingestion order

Run gate-bearing rubrics **first** (Q30, Q6, Q15, Q26, Q51, Q65, and the Vendor Profile
scope questions). Resolving those retires whole branches before you spend extraction
calls on them. Then the rest, in importance order so partial ingestion still yields a
useful demo.

### 5.6 The eval corpus — build this on day one

Take the provided corpus and plant defects, so you can *prove* the behaviours the judges
listed:

| Planted defect | Expected system behaviour |
|---|---|
| Policy says MFA mandatory; Slack thread says contractors exempt | node → `conflicted`, kind `policy_vs_practice`, targeted resolution question |
| No document anywhere about employee background checks | node stays `unknown`, appears high in queue, gets asked |
| 2023 policy says quarterly access reviews; 2026 infra config implies monthly | conflict kind `stale_vs_current`, recency-ranked recommendation |
| A doc that mentions "backups" but states no frequency | node → `vague`, follow-up asks frequency only |
| A doc containing a plausible-sounding claim the extractor might over-read | span validator rejects, no entry written |

Metrics to report in the demo: **fabrication rate (must be 0)**, conflict recall,
questions-asked per completed answer, and coverage before conversation (how many of 66
answered from docs alone). The brief explicitly says the winner is not the bot that asks
the most questions — so *questions-per-answer* is a metric worth showing on screen.

---

## 6. STAGE 2 — Ledger, review engine, conflict detection, API

**Owner: 1 person. You own the state. Everyone else reads and writes through you.**

### 6.1 Deliverables

| # | Deliverable |
|---|---|
| 2.1 | Persistence layer (Postgres, or SQLite for hackathon speed) |
| 2.2 | Seeding: rubrics.json → ledger nodes on company creation |
| 2.3 | Append-only entry writer with supersession |
| 2.4 | Review pass: state computation, vagueness rules, gate resolution |
| 2.5 | Conflict detector + conflict lifecycle |
| 2.6 | Confidence calculator (§3.6) |
| 2.7 | Queue ranker (§4.3) |
| 2.8 | The REST API in §3.7, including deltas |
| 2.9 | Correction / supersession endpoint |

### 6.2 Schema (SQLite/Postgres)

```sql
companies      (id, name, created_at, profile_json)
documents      (id, company_id, filename, source_type, doc_class, authored_at,
                uploaded_at, page_count, raw_path)
chunks         (id, doc_id, ordinal, page, char_start, char_end, text)
entries        (id, company_id, rubric_id, slot, value_json, confidence,
                source_kind, source_id, source_type, span, locator_json,
                authored_at, speaker, created_at, superseded_by, supersede_reason)
conflicts      (id, company_id, rubric_id, slot, kind, entry_a, entry_b,
                summary, resolution_question, status, resolved_by_entry, created_at)
sessions       (id, company_id, user_email, started_at, ended_at, current_theme)
messages       (id, session_id, role, content, created_at, node_refs_json)
node_state     (company_id, rubric_id, state, confidence, filled_slots_json,
                empty_required_json, attempted_unknown, last_touched)   -- derived cache
```

`node_state` is a **cache**, always rebuildable from `entries` + `conflicts` + rubrics.
Never treat it as truth. Rebuild on every review pass. This makes the whole system
debuggable: if the UI looks wrong, drop the cache and recompute.

`value_json` is JSON so it holds bools, strings, arrays, and durations uniformly.

### 6.3 The review pass

Runs on: session open, after every ingestion job, after every ledger write batch.

```
for each rubric:
    if depends_on and gate value known:
        state = not_applicable  (if gate fails)  → continue
    if depends_on and gate value unknown:
        state = pending_gate                     → continue
    current = newest non-superseded entry per slot
    filled  = slots with a current entry
    empty_required = required slots not in filled
    if open conflict on any slot:  state = conflicted
    elif empty_required:           state = vague if filled else unknown
    elif any current entry kind == user: state = user_confirmed
    else:                          state = verified
    if state in (unknown, vague) and attempted_unknown: state = attempted_unknown
    confidence = min over required slots (§3.6)
```

Keep it **deterministic and LLM-free**. This function is the reason the system is
explainable. If an LLM is anywhere in this loop, you cannot debug the graph.

### 6.4 Conflict detection

Triggered by the binder when a new entry disagrees with the current value of a slot.
Disagreement test by type:

- `bool`: values differ
- `enum`: values differ
- `duration` / `date`: differ beyond a tolerance you define per slot
- `text`: LLM adjudication — "do these two statements assert incompatible facts?" — with
  a bias toward *not* flagging paraphrases. Falsely flagging every rewording will drown
  the user in noise, which is worse than missing one.
- `list`: non-empty symmetric difference **only if** the slot is declared exhaustive
  (add `"exhaustive": true` to slot config where the list is meant to be complete, e.g.
  `coverage`). Otherwise treat as merge, not conflict.

Then classify the `kind` per §3.4 using source types and dates, generate a `summary` and
a **specific** `resolution_question` naming both sources and dates. Generic "can you
clarify?" is a wasted turn.

### 6.5 Corrections and supersession

`POST /api/company/:id/correction` must:

1. Write a new entry with `source.kind: "user"`.
2. Mark the prior entry `superseded_by` = new entry, `supersede_reason: "user_correction"`.
3. **Re-flag dependents**: if the corrected slot is a gate, re-evaluate every dependent
   node — including flipping nodes back from `not_applicable` if the gate now passes.
4. Resolve any open conflict on that slot in favour of the user.
5. Return the full `graph_delta` so the UI animates the ripple.

Point 3 is the one people forget. A user correcting "actually we do have a web app"
must resurrect Q31–35 from the dead.

---

## 7. STAGE 3 — Conversation layer

**Owner: 1 person. This is the product the judges actually talk to.**

### 7.1 Deliverables

| # | Deliverable |
|---|---|
| 3.1 | Session opener: the brief |
| 3.2 | Theme selection with ranked recommendations |
| 3.3 | Question generator from empty slots (batched) |
| 3.4 | Answer processing through the shared extract→validate→bind path |
| 3.5 | Conflict resolution dialogue |
| 3.6 | Correction intent detection |
| 3.7 | Evidence display in-conversation |
| 3.8 | Questionnaire render (JSON + xlsx writeback) |

### 7.2 The session opener

**Never open with a blank prompt.** The first message must demonstrate that the system
already did the work. Template:

> I've reviewed your uploaded documents and worked through the 66-question Regodit
> questionnaire.
>
> **Answered from your documents: 34.** Encryption at rest, data residency, access
> reviews, and your incident response plan are all covered — with sources.
> **Not applicable: 6** (no web application in scope, per your contract).
> **Conflicts I need you to settle: 2.**
> **Still unknown: 24**, of which 8 are high-priority for an enterprise buyer.
>
> Where would you like to start? I'd suggest the conflicts — they're blocking otherwise
> complete answers.
>
> `[Resolve conflicts (2)]  [Data Security (5 open)]  [Asset Management (7 open)]  [Show me everything]`

Those counts come from `GET /api/company/:id/stats`. This screen is your single best demo
moment: it proves "search before asking" at a glance.

### 7.3 Question generation

Driven by empty slots, not by LLM whim. Rules:

- **Batch related slots.** Ask "How often do you back up, and is it automated?" not two
  turns. Cap at 2–3 slots per turn; more reads like a form.
- **Lead with what you already know.** "Your policy says backups run nightly to S3 — is
  that still current, and are restores tested?" is far better than "Do you perform
  backups?" when a doc already fills `backups_exist`.
- **Use the slot `prompt` as a fallback** but let the LLM rewrite it in context so it
  sounds like a colleague, not a form field.
- **Never ask a question whose slot is already filled.** This is the brief's "avoid asking
  the same question twice" requirement, and it is structurally guaranteed by reading
  empty-slot lists rather than tracking asked-questions.
- **Ask gate questions first** within a theme.
- **Offer an out.** "I don't know" and "that's someone else's area" are legitimate and
  map to `attempted_unknown`.

### 7.4 Answer processing — the same path as documents

```
user utterance
  → extractor (same prompt family as Stage 1, source_type: "user")
  → span validator (span = the user's own words, so it always passes,
                    but keep the step so provenance is uniform)
  → binder (same code)
  → conflict detection (same code)
  → review pass
  → graph_delta returned to UI
```

Two behaviours that make this feel intelligent:

- **Harvest volunteered facts.** If the user, while answering about backups, says "we're
  on AWS us-east-1 only", that binds to the data-residency node in a different theme.
  Extract against *all* rubrics, not just the one you asked about. Then tell them: "Noted
  — that also answers question 19 on data residency."
- **Detect vagueness structurally.** "We patch quickly" fills `documented: true` and
  leaves both SLA durations empty → follow up on the durations specifically, quoting
  what they said.

### 7.5 Conflict resolution dialogue

Present both sides with source and date, state which one the authority/recency heuristic
favours and why, then ask. Never resolve silently.

> Your **Access Control Policy** (Nov 2024) says MFA is mandatory for all systems. But a
> **#eng-ops thread from 12 March 2026** says contractor GitHub accounts still don't have
> it enforced. The message is more recent and describes actual configuration, so I'd lean
> toward there being an exception — but I don't want to answer for you. Which is true today?
>
> `[Policy is accurate, no exceptions]  [Contractors are exempt]  [It's been fixed since]  [Let me explain]`

The resolution writes a user entry, supersedes the loser, closes the conflict, and — if
the answer is "contractors are exempt" — fills the `exceptions` slot rather than flipping
`required` to false. Nuance preserved.

### 7.6 Correction intent

Detect "actually", "that's outdated", "no, we changed that", "that's wrong". Route to the
correction endpoint. Confirm the change and show the ripple: "Updated — that also changes
your answer to Q59, which now reads *monthly* instead of *quarterly*."

### 7.7 Evidence display

Whenever the bot asserts something from documents, it shows the source inline:
document title, date, and the verbatim span, collapsible. Every claim, every time. This
is a scored bonus item and it is nearly free given the ledger.

### 7.8 Questionnaire render

Available at **any point**, not just at the end. Walk rubrics in spreadsheet question
order and emit per question:

```jsonc
{
  "question_id": 39,
  "question": "On what cadence are vulnerability scans performed?",
  "response": "Quarterly",                    // legal enum value where the sheet has a dropdown
  "status": "verified_from_documents",        // verified_from_documents | confirmed_by_user
                                              // | unknown | not_applicable | partial
  "confidence": 0.82,
  "comments": "Internal scans quarterly via Qualys; external scans monthly.",
  "evidence": [
    { "doc": "Vulnerability Management Policy v3", "date": "2024-11-03", "page": 4,
      "span": "Internal vulnerability scans shall be conducted no less than quarterly." }
  ],
  "gaps": []                                  // empty required slots, for partial answers
}
```

xlsx writeback: fill `Vendor Response`, `Comments / Clarification`, and `Source of
information / Evidence` in the `Vendor Security Responses` sheet, and the checklists in
`Vendor Profile`. Use the `xlsx` skill; preserve the original file's formatting and
dropdown validations. Colour-code status if time permits (green verified, blue user,
amber partial, grey unknown).

**Unknown must render as "Unknown — requires confirmation", never as a guess.** Say this
in your prompt, and assert it in a test.

---

## 8. STAGE 4 — Frontend

**Owner: 1 person. The graph is what makes this legible in a 5-minute demo.**

### 8.1 Deliverables

| # | Deliverable |
|---|---|
| 4.1 | App shell, company creation, document upload with ingestion progress |
| 4.2 | Knowledge graph visualisation (the centrepiece) |
| 4.3 | Chat panel with evidence cards and quick-reply chips |
| 4.4 | Node inspector drawer |
| 4.5 | Questionnaire view + export |
| 4.6 | Coverage stats header |

### 8.2 Layout

```
┌────────────────────────────────────────────────────────────────┐
│  Coverage: ██████████░░░░░░  34 verified · 6 user · 2 conflict │
│            18 vague · 6 N/A                            [Export]│
├──────────────────────────────┬─────────────────────────────────┤
│                              │                                 │
│      KNOWLEDGE GRAPH         │        CHAT PANEL               │
│      (themes → nodes)        │                                 │
│                              │   evidence cards inline         │
│      click node →            │   quick-reply chips             │
│      inspector drawer        │                                 │
│                              │                                 │
├──────────────────────────────┴─────────────────────────────────┤
│  Tabs:  Graph  │  Questionnaire  │  Documents  │  Conflicts    │
└────────────────────────────────────────────────────────────────┘
```

Graph and chat **side by side**, always. The core wow-moment is a node changing colour in
real time as the user answers a question. If the graph is on another tab, that moment
never happens.

### 8.3 Graph rendering

Recommended: force-directed or radial clustering by theme (d3-force, react-flow, or
cytoscape). 14 theme hubs, ~70 sub-claim nodes, evidence nodes shown only on
focus/expand (otherwise it's unreadable).

**Colour = state.** Use the §3.3 table. Suggested palette:

| state | fill | treatment |
|---|---|---|
| `unknown` | neutral 300 | solid |
| `vague` | amber 400 | solid, dashed ring |
| `conflicted` | red 500 | solid, pulsing ring |
| `verified` | green 500 | solid |
| `user_confirmed` | blue 500 | solid |
| `not_applicable` | neutral 200 | diagonal hatch, 40% opacity |
| `pending_gate` | neutral 200 | dotted outline only |
| `attempted_unknown` | neutral 300 | solid with centre dot |

**Node size** = importance. **Ring thickness** = confidence. **Conflicts** = a red edge
drawn between the two disagreeing evidence nodes, always visible even when evidence is
collapsed.

**Slot-level detail on hover**: a mini pip strip under the node, one pip per required
slot, filled or hollow. This is what makes "vague" legible at a glance — you can see
three of four slots filled without clicking.

Animate `graph_delta` transitions over ~600ms. Never re-render the whole graph on a
message; that kills the effect.

### 8.4 Node inspector

Opens on click. Shows: claim text, mapped question ids, every slot with current value,
state, and confidence; provenance list with document name, date, and the verbatim span
(clicking scrolls the source viewer to it); conflict panel if open; edit control that
posts a correction; and "ask me about this" which pushes the node to the front of the
conversation queue.

### 8.5 Chat panel

- Evidence cards render as collapsible blocks under bot messages, not as raw links.
- Quick-reply chips for bools, enums, and conflict resolutions — much faster than typing
  and it guarantees legal enum values reach the backend.
- A subtle "learned" toast when a node changes state: *Backups → complete*.
- Theme picker as chips with open-node counts, ranked by the queue.
- Show which node the current question belongs to; clicking it opens the inspector.

### 8.6 Questionnaire view

Table of all 66 in spreadsheet order: id, question, answer, status pill, confidence bar,
evidence count. Filterable by status. Clicking a row opens the node inspector. Export
button hits `/questionnaire.xlsx`.

Show the **partial** state honestly — a question with 3 of 4 slots filled renders its
partial answer plus an explicit "still needed: cadence". Judges will look for exactly this
kind of honesty.

### 8.7 Design direction

Follow `/mnt/skills/public/frontend-design/SKILL.md` if building in this environment.
Dense, information-first, dark-mode-friendly. This is a security analyst tool, not a
consumer chat app. Avoid the default purple-gradient LLM-app look — it reads as
templated and the judges have seen forty of them today.

---

## 9. Integration plan and cut list

### 9.1 Order of work

| When | Stage 1 | Stage 2 | Stage 3 | Stage 4 |
|---|---|---|---|---|
| Hours 0–4 | **rubrics.json** (ship early, even rough) | schema + seeding + API skeleton with mock data | prompt design, dialogue flow on mocks | shell + graph against mock JSON |
| Hours 4–10 | loader, chunker, extractor, validator | review pass, conflict detector, confidence | question generator, answer processing | graph wired to real API, inspector |
| Hours 10–16 | binder + gates + eval corpus | queue, corrections, deltas | conflict dialogue, corrections, evidence cards | chat panel, questionnaire view |
| Hours 16–20 | ingest the real corpus, tune | tune ranking, harden | render + xlsx writeback | export, polish, animations |
| Final | rehearse demo together | | | |

**Unblocking trick:** Stage 2 publishes a mock API returning a hand-written graph JSON
within the first two hours. Stages 3 and 4 build against that and never wait.

### 9.2 Cut list, in order of what to drop first

1. Voice interaction (bonus, high effort, low marginal score)
2. Multi-stakeholder (explicitly out of scope for v1 — but keep `speaker` on entries so
   it is a one-day add, and say so in the demo)
3. xlsx writeback (JSON render + on-screen table is enough if time is short)
4. Evidence node rendering in the graph (keep it in the inspector only)
5. Free-text conflict adjudication (restrict conflicts to typed slots)

**Never cut:** the span validator, the review pass determinism, evidence display,
unknown-as-a-legitimate-answer. Those four *are* the scored criteria.

### 9.3 Demo script (rehearse this)

1. Empty graph, all grey. "Here is what the questionnaire requires. We know nothing yet."
2. Upload the corpus. Nodes light up live. "34 of 66 answered from documents, zero
   questions asked."
3. Open the session. Read the brief. Point at the two conflicts.
4. Resolve the MFA conflict. Show both sources with dates. Answer. Node turns blue, the
   `exceptions` slot fills, Q60 and Q61 both update.
5. Answer a vague backup question. Watch the follow-up target exactly the missing slot.
6. Say something offhand that answers a different theme. Bot notices and credits it.
7. Correct something. Show the ripple through dependents.
8. Ask about background checks — nothing in the corpus. Bot says unknown and asks.
   **Emphasise: it did not guess.**
9. Export. Show the three-way status split and the evidence column.
10. Close on the metric: fabrication rate 0, questions asked per answer.

---

## 10. Non-negotiables checklist

Before you merge anything, confirm:

- [ ] Every ledger entry has a span that verbatim exists in its source
- [ ] No LLM writes to the ledger directly
- [ ] The review pass contains no LLM calls
- [ ] Confidence is computed, never self-reported
- [ ] Conflicts are never auto-resolved without the user
- [ ] `not_applicable` is visually distinct from `unknown`
- [ ] A question with a filled slot is never asked again
- [ ] Unknown renders as unknown, never as a guess
- [ ] Every document-derived answer displays its source
- [ ] The graph updates live during conversation
