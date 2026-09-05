-- Run this in the Supabase SQL editor (Project > SQL Editor > New query)

create extension if not exists vector;

-- ============================================================
-- 1. Document chunks (RAG corpus)
-- ============================================================
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,           -- e.g. 'Regodit_access_control_policy.docx'
  source_type text not null,           -- policy | infra | contract | assessment | message | employee_info
  authored_at date,                    -- when the document itself was authored/last reviewed (nullable; P1 may populate)
  created_at timestamptz default now()
);

create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  content text not null,
  section_title text,                  -- e.g. '4. Authentication' — docs are already headed, use these as chunk boundaries
  embedding vector(1536),              -- adjust dim to match your embedding model
  created_at timestamptz default now()
);

create index if not exists chunks_embedding_idx
  on chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Safe to re-run against a database that already ran an earlier version of this file
-- (create table if not exists won't add columns to an existing table).
alter table documents add column if not exists authored_at date;

-- ============================================================
-- 2. Knowledge base (one row per questionnaire item — the core object)
-- ============================================================
create table if not exists questionnaire_items (
  id text primary key,                 -- 'mfa_enabled', 'data_storage_location', etc.
  question text not null,
  category text,                       -- Access Control | Data Protection | Backups | Vuln Mgmt | HR/Offboarding ...
  priority int default 5,              -- lower = ask sooner (unknowns/conflicts get boosted at runtime)
  status text not null default 'unknown'
    check (status in ('unknown','vague','verified','confirmed','conflict','not_applicable')),
  answer text,
  evidence jsonb not null default '[]',    -- [{doc, section, detail, similarity}]
  conflicts jsonb not null default '[]',   -- [{type, detail, sources: [...]}]
  confidence float not null default 0,
  asked_user boolean not null default false,
  last_user_note text,                     -- raw quote of what the user said, for traceability
  updated_at timestamptz default now()
);

alter table questionnaire_items drop constraint if exists questionnaire_items_status_check;
alter table questionnaire_items add constraint questionnaire_items_status_check
  check (status in ('unknown','vague','verified','confirmed','conflict','not_applicable'));

-- Stage 3 requires this column for answer-type-aware follow-up and LLM skipping.
-- Add it if a previous schema run predates Stage 3.
alter table questionnaire_items add column if not exists answer_type text not null default 'text'
  check (answer_type in ('boolean','text','document_request'));

-- ============================================================
-- 2b. Doc hits — per-question candidate values found in documents.
--     Multiple rows per question are expected and are what conflict
--     detection (doc vs doc, or doc vs incoming answer) compares against.
-- ============================================================
create table if not exists doc_hits (
  id uuid primary key default gen_random_uuid(),
  question_id text not null references questionnaire_items(id) on delete cascade,
  value text not null,
  source_doc text not null,
  source_date date,
  span text not null,
  created_at timestamptz default now()
);

create index if not exists doc_hits_question_id_idx on doc_hits(question_id);

-- ============================================================
-- 3. Conversation log (for follow-up logic + audit trail, not the source of truth)
-- ============================================================
create table if not exists conversation_turns (
  id bigint generated always as identity primary key,
  session_id text not null,
  role text not null check (role in ('user','assistant')),
  content text not null,
  related_item_id text references questionnaire_items(id),
  created_at timestamptz default now()
);

-- ============================================================
-- 4. Vector similarity search function (called from the app)
-- ============================================================
-- CREATE OR REPLACE can't change an existing function's RETURNS TABLE shape, and
-- authored_at is new here — drop first so a re-run against an already-provisioned
-- database picks up the wider return type.
drop function if exists match_chunks(vector, int);

create or replace function match_chunks(
  query_embedding vector(1536),
  match_count int default 5
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  section_title text,
  source_name text,
  source_type text,
  authored_at date,
  similarity float
)
language sql stable
as $$
  select
    c.id,
    c.document_id,
    c.content,
    c.section_title,
    d.source_name,
    d.source_type,
    d.authored_at,
    1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
