-- +goose Up
CREATE TABLE git_connections (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    display_name TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    auth_kind TEXT NOT NULL,
    secret_ciphertext BYTEA NOT NULL,
    capabilities_json JSONB NOT NULL DEFAULT '{}',
    created_by UUID REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_bindings (
    project_id UUID PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES git_connections (id) ON DELETE RESTRICT,
    repo_url TEXT NOT NULL,
    repo_full_name TEXT NOT NULL DEFAULT '',
    default_branch TEXT NOT NULL DEFAULT 'main',
    docs_root TEXT NOT NULL DEFAULT 'docs',
    generated_roots TEXT[] NOT NULL DEFAULT '{}',
    last_synced_sha TEXT NOT NULL DEFAULT '',
    last_synced_at TIMESTAMPTZ,
    webhook_id TEXT NOT NULL DEFAULT '',
    webhook_secret BYTEA,
    poll_fallback BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'idle',
    status_error TEXT NOT NULL DEFAULT '',
    workspace_relpath TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
    id UUID PRIMARY KEY,
    org_id UUID,
    project_id UUID,
    kind TEXT NOT NULL,
    payload_json JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at TIMESTAMPTZ,
    locked_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX jobs_claim_idx ON jobs (status, run_after);

CREATE TABLE webhook_events (
    id UUID PRIMARY KEY,
    connection_id UUID REFERENCES git_connections (id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects (id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    delivery_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    payload_hash BYTEA NOT NULL,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, delivery_id, payload_hash)
);

CREATE TABLE edit_leases (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (project_id, path)
);

CREATE TABLE doc_versions (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    alias TEXT NOT NULL DEFAULT '',
    git_ref TEXT NOT NULL,
    immutable BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE TABLE publish_runs (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    target TEXT NOT NULL,
    version_name TEXT NOT NULL DEFAULT 'latest',
    status TEXT NOT NULL DEFAULT 'queued',
    artifact_path TEXT NOT NULL DEFAULT '',
    public_url TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

CREATE TABLE search_documents (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    version_name TEXT NOT NULL DEFAULT 'latest',
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    headings TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '',
    tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(headings, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(keywords, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(body, '')), 'C')
    ) STORED,
    UNIQUE (project_id, version_name, path)
);

CREATE INDEX search_documents_tsv_idx ON search_documents USING GIN (tsv);

CREATE TABLE maintainer_mappings (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    source_match TEXT NOT NULL,
    extractor TEXT NOT NULL,
    output TEXT NOT NULL,
    options_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE maintainer_snapshots (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    source_path TEXT NOT NULL,
    source_sha TEXT NOT NULL,
    ir_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, source_path)
);

CREATE TABLE redirects (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    UNIQUE (project_id, from_path)
);

CREATE TABLE api_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash BYTEA NOT NULL UNIQUE,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS host TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS base_path TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE projects DROP COLUMN IF EXISTS host;
ALTER TABLE projects DROP COLUMN IF EXISTS base_path;
DROP TABLE IF EXISTS redirects;
DROP TABLE IF EXISTS maintainer_snapshots;
DROP TABLE IF EXISTS maintainer_mappings;
DROP TABLE IF EXISTS search_documents;
DROP TABLE IF EXISTS publish_runs;
DROP TABLE IF EXISTS doc_versions;
DROP TABLE IF EXISTS edit_leases;
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS project_bindings;
DROP TABLE IF EXISTS git_connections;
