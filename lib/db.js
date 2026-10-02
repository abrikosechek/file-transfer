'use strict';

const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    });
  }
  return pool;
}

async function migrate() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS items (
      id UUID PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      size_bytes BIGINT NOT NULL DEFAULT 0,
      mime TEXT,
      original_name TEXT
    );

    CREATE TABLE IF NOT EXISTS item_files (
      id UUID PRIMARY KEY,
      item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      mime TEXT,
      storage_name TEXT NOT NULL,
      UNIQUE (item_id, relative_path)
    );

    CREATE INDEX IF NOT EXISTS items_expires_at_idx ON items (expires_at);
    CREATE INDEX IF NOT EXISTS items_created_at_idx ON items (created_at DESC);
    CREATE INDEX IF NOT EXISTS item_files_item_id_idx ON item_files (item_id);

    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL COLLATE "default",
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id UUID PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      retention TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completing', 'completed', 'aborted')),
      chunk_size INT NOT NULL,
      total_bytes BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS upload_files (
      id UUID PRIMARY KEY,
      upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      file_index INT NOT NULL,
      relative_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      mime TEXT,
      storage_name TEXT NOT NULL,
      chunk_count INT NOT NULL,
      UNIQUE (upload_id, file_index)
    );

    CREATE TABLE IF NOT EXISTS upload_chunks (
      upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      file_index INT NOT NULL,
      chunk_index INT NOT NULL,
      size_bytes INT NOT NULL,
      PRIMARY KEY (upload_id, file_index, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS uploads_status_updated_idx ON uploads (status, updated_at);
    CREATE INDEX IF NOT EXISTS upload_files_upload_id_idx ON upload_files (upload_id);
  `);

  // connect-pg-simple expects primary key on sid
  await p.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
      ) THEN
        ALTER TABLE session ADD CONSTRAINT session_pkey PRIMARY KEY (sid);
      END IF;
    END $$;
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
  `);
}

module.exports = { getPool, migrate };
