-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- It sets up the vector store now so step 3 (RAG ingestion) has somewhere to write.

-- 1. Turn on pgvector, the extension that lets Postgres store and search vectors.
create extension if not exists vector;

-- 2. One row per document chunk. 'domain' is the Electrical/Mechanical namespace.
--    gemini-embedding-001 returns 768-dimension vectors by default.
create table if not exists chunks (
  id         bigint generated always as identity primary key,
  domain     text not null,          -- 'electrical' | 'mechanical'
  content    text not null,          -- the chunk of document text
  embedding  vector(768),            -- its vector, filled in during ingestion
  created_at timestamptz default now()
);

-- 3. An index so similarity search stays fast as the table grows.
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- 4. The search function the router calls: given a query vector and a domain,
--    return the closest chunks with a similarity score (1.0 = identical).
create or replace function match_chunks (
  query_embedding vector(768),
  match_domain    text,
  match_count     int default 5
)
returns table (id bigint, content text, similarity float)
language sql stable as $$
  select
    chunks.id,
    chunks.content,
    1 - (chunks.embedding <=> query_embedding) as similarity
  from chunks
  where chunks.domain = match_domain
  order by chunks.embedding <=> query_embedding
  limit match_count;
$$;
