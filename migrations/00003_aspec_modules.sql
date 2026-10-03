-- +goose Up
-- Tables and columns from the copied ASPEC modules (auth, users, rbac, api-keys).
-- Existing users, organisations, roles, invitations, sessions, and audit_events stay canonical.

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_json JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings_json JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences_json JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspend_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
UPDATE users SET display_name = name WHERE display_name = '';

CREATE TABLE IF NOT EXISTS auth_lockouts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    failed_count INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_lockouts_email_uq ON auth_lockouts (email);

CREATE TABLE IF NOT EXISTS auth_reset_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    created_by UUID REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_reset_tokens_user_idx ON auth_reset_tokens (user_id);

CREATE TABLE IF NOT EXISTS rbac_permissions (
    key TEXT PRIMARY KEY,
    description TEXT,
    system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rbac_roles (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    permissions JSONB NOT NULL,
    denies JSONB NOT NULL,
    parents JSONB NOT NULL,
    assignable_scopes JSONB NOT NULL,
    system BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rbac_meta (
    key TEXT PRIMARY KEY,
    value BIGINT NOT NULL
);
INSERT INTO rbac_meta (key, value) VALUES ('roles_revision', 0) ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS rbac_assignments (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    role_key TEXT NOT NULL,
    org_id TEXT NOT NULL DEFAULT '',
    team_id TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    created_by TEXT,
    expires_at BIGINT,
    CONSTRAINT rbac_assignments_unique UNIQUE (subject_id, role_key, org_id, team_id)
);
CREATE INDEX IF NOT EXISTS rbac_assignments_role_idx ON rbac_assignments (role_key);
CREATE INDEX IF NOT EXISTS rbac_assignments_scope_idx ON rbac_assignments (org_id, team_id);
CREATE INDEX IF NOT EXISTS rbac_assignments_subject_idx ON rbac_assignments (subject_id);

CREATE TABLE IF NOT EXISTS rbac_grants (
    id TEXT PRIMARY KEY,
    subject_id TEXT,
    role_key TEXT,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    org_id TEXT NOT NULL DEFAULT '',
    permissions JSONB NOT NULL,
    effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    created_at BIGINT NOT NULL,
    created_by TEXT,
    expires_at BIGINT,
    CHECK ((subject_id IS NULL) <> (role_key IS NULL))
);
CREATE INDEX IF NOT EXISTS rbac_grants_resource_idx ON rbac_grants (resource_type, resource_id);

CREATE TABLE IF NOT EXISTS rbac_ownership_rules (
    id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,
    permissions JSONB NOT NULL,
    description TEXT,
    system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rbac_policies (
    id TEXT PRIMARY KEY,
    description TEXT,
    effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    permissions JSONB NOT NULL,
    resource_types JSONB,
    roles JSONB,
    condition_json JSONB NOT NULL,
    system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rbac_schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at BIGINT NOT NULL
);
INSERT INTO rbac_schema_migrations (id, applied_at) VALUES ('001_initial', 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS api_keys_keys (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    key_hash TEXT NOT NULL,
    display_prefix TEXT NOT NULL,
    prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    scopes JSONB NOT NULL,
    status TEXT NOT NULL,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    org_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    expires_at BIGINT,
    revoked_at BIGINT,
    revoked_reason TEXT,
    revoked_by TEXT,
    previous_key_hash TEXT,
    previous_expires_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    last_used_at BIGINT,
    last_used_ip TEXT,
    use_count BIGINT NOT NULL DEFAULT 0,
    rate_limit INTEGER,
    rate_limit_window_ms BIGINT
);
CREATE INDEX IF NOT EXISTS api_keys_keys_owner_idx ON api_keys_keys (owner_type, owner_id, created_at);
CREATE INDEX IF NOT EXISTS api_keys_keys_status_idx ON api_keys_keys (status, created_at);
CREATE INDEX IF NOT EXISTS api_keys_keys_hash_idx ON api_keys_keys (key_hash);

CREATE TABLE IF NOT EXISTS api_keys_service_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    org_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    disabled_at BIGINT
);

CREATE TABLE IF NOT EXISTS api_keys_schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at BIGINT NOT NULL
);
INSERT INTO api_keys_schema_migrations (id, applied_at) VALUES ('001_initial', 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users_activity (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    at BIGINT NOT NULL,
    actor_id TEXT,
    ip TEXT,
    user_agent TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS users_activity_user_idx ON users_activity (user_id, at, id);

-- +goose Down
DROP TABLE IF EXISTS users_activity;
DROP TABLE IF EXISTS api_keys_schema_migrations;
DROP TABLE IF EXISTS api_keys_service_accounts;
DROP TABLE IF EXISTS api_keys_keys;
DROP TABLE IF EXISTS rbac_schema_migrations;
DROP TABLE IF EXISTS rbac_policies;
DROP TABLE IF EXISTS rbac_ownership_rules;
DROP TABLE IF EXISTS rbac_grants;
DROP TABLE IF EXISTS rbac_assignments;
DROP TABLE IF EXISTS rbac_meta;
DROP TABLE IF EXISTS rbac_roles;
DROP TABLE IF EXISTS rbac_permissions;
DROP TABLE IF EXISTS auth_reset_tokens;
DROP TABLE IF EXISTS auth_lockouts;
ALTER TABLE users DROP COLUMN IF EXISTS version;
ALTER TABLE users DROP COLUMN IF EXISTS suspended_until;
ALTER TABLE users DROP COLUMN IF EXISTS suspend_reason;
ALTER TABLE users DROP COLUMN IF EXISTS metadata_json;
ALTER TABLE users DROP COLUMN IF EXISTS preferences_json;
ALTER TABLE users DROP COLUMN IF EXISTS settings_json;
ALTER TABLE users DROP COLUMN IF EXISTS profile_json;
ALTER TABLE users DROP COLUMN IF EXISTS display_name;
