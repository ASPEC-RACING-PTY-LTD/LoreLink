-- +goose Up
CREATE TABLE instances (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    public_base_url TEXT NOT NULL DEFAULT '',
    portal_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    setup_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash BYTEA NOT NULL,
    password_salt BYTEA NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    instance_capabilities TEXT[] NOT NULL DEFAULT '{}',
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organisations (
    id UUID PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    settings_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
    id UUID PRIMARY KEY,
    org_id UUID REFERENCES organisations (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    capabilities TEXT[] NOT NULL,
    UNIQUE (org_id, name)
);

CREATE TABLE org_memberships (
    org_id UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles (id),
    PRIMARY KEY (org_id, user_id)
);

CREATE TABLE teams (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE (org_id, name)
);

CREATE TABLE team_memberships (
    team_id UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE invitations (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role_id UUID NOT NULL REFERENCES roles (id),
    token_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_by UUID REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private',
    icon TEXT NOT NULL DEFAULT '',
    docs_root TEXT NOT NULL DEFAULT 'docs',
    default_branch TEXT NOT NULL DEFAULT 'main',
    publish_policy TEXT NOT NULL DEFAULT 'manual',
    branding_override_json JSONB NOT NULL DEFAULT '{}',
    settings_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, slug)
);

CREATE TABLE audit_events (
    id UUID PRIMARY KEY,
    actor_user_id UUID,
    org_id UUID,
    project_id UUID,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    metadata_json JSONB NOT NULL DEFAULT '{}',
    ip TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX invitations_org_idx ON invitations (org_id);

INSERT INTO roles (id, org_id, name, capabilities) VALUES
    ('00000000-0000-4000-8000-000000000001', NULL, 'Viewer', ARRAY['org.view', 'docs.view', 'audit.view']),
    ('00000000-0000-4000-8000-000000000002', NULL, 'Writer', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage']),
    ('00000000-0000-4000-8000-000000000003', NULL, 'Editor', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage', 'docs.delete']),
    ('00000000-0000-4000-8000-000000000004', NULL, 'Publisher', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage', 'docs.delete', 'docs.publish', 'docs.versions.manage']),
    ('00000000-0000-4000-8000-000000000005', NULL, 'Maintainer', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage', 'docs.delete', 'docs.publish', 'docs.versions.manage', 'docs.generated.manage', 'jobs.view', 'docs.search.reindex']),
    ('00000000-0000-4000-8000-000000000006', NULL, 'Project Admin', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage', 'docs.delete', 'docs.publish', 'docs.versions.manage', 'docs.generated.manage', 'jobs.view', 'docs.search.reindex', 'docs.settings.manage', 'docs.members.manage', 'project.connections.manage']),
    ('00000000-0000-4000-8000-000000000007', NULL, 'Org Admin', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage', 'docs.delete', 'docs.publish', 'docs.versions.manage', 'docs.generated.manage', 'jobs.view', 'docs.search.reindex', 'docs.settings.manage', 'docs.members.manage', 'project.connections.manage', 'org.settings.manage', 'org.members.manage', 'org.teams.manage', 'org.projects.create', 'org.connections.manage', 'org.audit.view']);

-- +goose Down
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS team_memberships;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS org_memberships;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS organisations;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS instances;
