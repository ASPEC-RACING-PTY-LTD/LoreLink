package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
)

func (s *Store) GetProject(ctx context.Context, id string) (*Project, error) {
	return s.scanProject(s.DB.QueryRowContext(ctx, `
		SELECT id::text, org_id::text, name, slug, description, visibility, docs_root, default_branch, publish_policy, host, base_path, created_at
		FROM projects WHERE id = $1`, id))
}

func (s *Store) GetProjectBySlug(ctx context.Context, orgID, slug string) (*Project, error) {
	return s.scanProject(s.DB.QueryRowContext(ctx, `
		SELECT id::text, org_id::text, name, slug, description, visibility, docs_root, default_branch, publish_policy, host, base_path, created_at
		FROM projects WHERE org_id = $1 AND slug = $2`, orgID, slug))
}

func (s *Store) GetProjectByHost(ctx context.Context, host string) (*Project, error) {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return nil, ErrNotFound
	}
	return s.scanProject(s.DB.QueryRowContext(ctx, `
		SELECT id::text, org_id::text, name, slug, description, visibility, docs_root, default_branch, publish_policy, host, base_path, created_at
		FROM projects WHERE lower(host) = $1 LIMIT 1`, host))
}

func (s *Store) GetProjectByOrgSlug(ctx context.Context, orgSlug, projectSlug string) (*Project, error) {
	return s.scanProject(s.DB.QueryRowContext(ctx, `
		SELECT p.id::text, p.org_id::text, p.name, p.slug, p.description, p.visibility, p.docs_root, p.default_branch, p.publish_policy, p.host, p.base_path, p.created_at
		FROM projects p
		JOIN organisations o ON o.id = p.org_id
		WHERE o.slug = $1 AND p.slug = $2`, orgSlug, projectSlug))
}

func (s *Store) scanProject(row *sql.Row) (*Project, error) {
	var p Project
	err := row.Scan(&p.ID, &p.OrgID, &p.Name, &p.Slug, &p.Description, &p.Visibility, &p.DocsRoot, &p.DefaultBranch, &p.PublishPolicy, &p.Host, &p.BasePath, &p.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) UpdateProject(ctx context.Context, p Project) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE projects SET name = $2, description = $3, visibility = $4, docs_root = $5, default_branch = $6,
			publish_policy = $7, host = $8, base_path = $9
		WHERE id = $1`,
		p.ID, p.Name, p.Description, p.Visibility, p.DocsRoot, p.DefaultBranch, p.PublishPolicy, p.Host, p.BasePath)
	return err
}

func (s *Store) SetPortalEnabled(ctx context.Context, enabled bool) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE instances SET portal_enabled = $1`, enabled)
	return err
}

func (s *Store) CreateConnection(ctx context.Context, c GitConnection) (*GitConnection, error) {
	if c.ID == "" {
		c.ID = uuid.NewString()
	}
	if len(c.CapabilitiesJSON) == 0 {
		c.CapabilitiesJSON = []byte("{}")
	}
	err := s.DB.QueryRowContext(ctx, `
		INSERT INTO git_connections (id, org_id, provider, display_name, base_url, auth_kind, secret_ciphertext, capabilities_json, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING created_at`,
		c.ID, c.OrgID, c.Provider, c.DisplayName, c.BaseURL, c.AuthKind, c.SecretCiphertext, c.CapabilitiesJSON, c.CreatedBy).
		Scan(&c.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *Store) ListConnections(ctx context.Context, orgID string) ([]GitConnection, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, org_id::text, provider, display_name, base_url, auth_kind, secret_ciphertext, capabilities_json, created_by::text, created_at
		FROM git_connections WHERE org_id = $1 ORDER BY display_name`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GitConnection
	for rows.Next() {
		var c GitConnection
		var createdBy sql.NullString
		if err := rows.Scan(&c.ID, &c.OrgID, &c.Provider, &c.DisplayName, &c.BaseURL, &c.AuthKind, &c.SecretCiphertext, &c.CapabilitiesJSON, &createdBy, &c.CreatedAt); err != nil {
			return nil, err
		}
		if createdBy.Valid {
			c.CreatedBy = &createdBy.String
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) GetConnection(ctx context.Context, id string) (*GitConnection, error) {
	var c GitConnection
	var createdBy sql.NullString
	err := s.DB.QueryRowContext(ctx, `
		SELECT id::text, org_id::text, provider, display_name, base_url, auth_kind, secret_ciphertext, capabilities_json, created_by::text, created_at
		FROM git_connections WHERE id = $1`, id).
		Scan(&c.ID, &c.OrgID, &c.Provider, &c.DisplayName, &c.BaseURL, &c.AuthKind, &c.SecretCiphertext, &c.CapabilitiesJSON, &createdBy, &c.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if createdBy.Valid {
		c.CreatedBy = &createdBy.String
	}
	return &c, nil
}

func (s *Store) DeleteConnection(ctx context.Context, id string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM git_connections WHERE id = $1`, id)
	return err
}

func (s *Store) UpsertBinding(ctx context.Context, b ProjectBinding) error {
	if b.GeneratedRoots == nil {
		b.GeneratedRoots = []string{}
	}
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO project_bindings (
			project_id, connection_id, repo_url, repo_full_name, default_branch, docs_root, generated_roots,
			last_synced_sha, webhook_id, webhook_secret, poll_fallback, status, status_error, workspace_relpath, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
		ON CONFLICT (project_id) DO UPDATE SET
			connection_id = EXCLUDED.connection_id,
			repo_url = EXCLUDED.repo_url,
			repo_full_name = EXCLUDED.repo_full_name,
			default_branch = EXCLUDED.default_branch,
			docs_root = EXCLUDED.docs_root,
			generated_roots = EXCLUDED.generated_roots,
			webhook_id = EXCLUDED.webhook_id,
			webhook_secret = EXCLUDED.webhook_secret,
			poll_fallback = EXCLUDED.poll_fallback,
			status = EXCLUDED.status,
			status_error = EXCLUDED.status_error,
			workspace_relpath = EXCLUDED.workspace_relpath,
			updated_at = now()`,
		b.ProjectID, b.ConnectionID, b.RepoURL, b.RepoFullName, b.DefaultBranch, b.DocsRoot, pq.Array(b.GeneratedRoots),
		b.LastSyncedSHA, b.WebhookID, b.WebhookSecret, b.PollFallback, b.Status, b.StatusError, b.WorkspaceRelpath)
	return err
}

func (s *Store) GetBinding(ctx context.Context, projectID string) (*ProjectBinding, error) {
	var b ProjectBinding
	var lastSynced sql.NullTime
	err := s.DB.QueryRowContext(ctx, `
		SELECT project_id::text, connection_id::text, repo_url, repo_full_name, default_branch, docs_root, generated_roots,
			last_synced_sha, last_synced_at, webhook_id, webhook_secret, poll_fallback, status, status_error, workspace_relpath, updated_at
		FROM project_bindings WHERE project_id = $1`, projectID).
		Scan(&b.ProjectID, &b.ConnectionID, &b.RepoURL, &b.RepoFullName, &b.DefaultBranch, &b.DocsRoot, pq.Array(&b.GeneratedRoots),
			&b.LastSyncedSHA, &lastSynced, &b.WebhookID, &b.WebhookSecret, &b.PollFallback, &b.Status, &b.StatusError, &b.WorkspaceRelpath, &b.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if lastSynced.Valid {
		b.LastSyncedAt = &lastSynced.Time
	}
	return &b, nil
}

func (s *Store) ListBindingsForConnection(ctx context.Context, connectionID string) ([]ProjectBinding, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT project_id::text, connection_id::text, repo_url, repo_full_name, default_branch, docs_root, generated_roots,
			last_synced_sha, last_synced_at, webhook_id, webhook_secret, poll_fallback, status, status_error, workspace_relpath, updated_at
		FROM project_bindings WHERE connection_id = $1`, connectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProjectBinding
	for rows.Next() {
		var b ProjectBinding
		var lastSynced sql.NullTime
		if err := rows.Scan(&b.ProjectID, &b.ConnectionID, &b.RepoURL, &b.RepoFullName, &b.DefaultBranch, &b.DocsRoot, pq.Array(&b.GeneratedRoots),
			&b.LastSyncedSHA, &lastSynced, &b.WebhookID, &b.WebhookSecret, &b.PollFallback, &b.Status, &b.StatusError, &b.WorkspaceRelpath, &b.UpdatedAt); err != nil {
			return nil, err
		}
		if lastSynced.Valid {
			b.LastSyncedAt = &lastSynced.Time
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) ListPollBindings(ctx context.Context) ([]ProjectBinding, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT project_id::text, connection_id::text, repo_url, repo_full_name, default_branch, docs_root, generated_roots,
			last_synced_sha, last_synced_at, webhook_id, webhook_secret, poll_fallback, status, status_error, workspace_relpath, updated_at
		FROM project_bindings WHERE poll_fallback = TRUE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProjectBinding
	for rows.Next() {
		var b ProjectBinding
		var lastSynced sql.NullTime
		if err := rows.Scan(&b.ProjectID, &b.ConnectionID, &b.RepoURL, &b.RepoFullName, &b.DefaultBranch, &b.DocsRoot, pq.Array(&b.GeneratedRoots),
			&b.LastSyncedSHA, &lastSynced, &b.WebhookID, &b.WebhookSecret, &b.PollFallback, &b.Status, &b.StatusError, &b.WorkspaceRelpath, &b.UpdatedAt); err != nil {
			return nil, err
		}
		if lastSynced.Valid {
			b.LastSyncedAt = &lastSynced.Time
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) UpdateBindingSync(ctx context.Context, projectID, sha, status, statusError string) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE project_bindings
		SET last_synced_sha = $2, last_synced_at = now(), status = $3, status_error = $4, updated_at = now()
		WHERE project_id = $1`, projectID, sha, status, statusError)
	return err
}

func (s *Store) EnqueueJob(ctx context.Context, j Job) (*Job, error) {
	if j.ID == "" {
		j.ID = uuid.NewString()
	}
	if len(j.PayloadJSON) == 0 {
		j.PayloadJSON = []byte("{}")
	}
	if !json.Valid(j.PayloadJSON) {
		j.PayloadJSON = []byte("{}")
	}
	if j.RunAfter.IsZero() {
		j.RunAfter = time.Now().UTC()
	}
	if j.Status == "" {
		j.Status = "queued"
	}
	err := s.DB.QueryRowContext(ctx, `
		INSERT INTO jobs (id, org_id, project_id, kind, payload_json, status, run_after)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING created_at, updated_at`,
		j.ID, j.OrgID, j.ProjectID, j.Kind, j.PayloadJSON, j.Status, j.RunAfter).
		Scan(&j.CreatedAt, &j.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &j, nil
}

func (s *Store) ClaimJobs(ctx context.Context, worker string, limit int) ([]Job, error) {
	if limit <= 0 {
		limit = 4
	}
	rows, err := s.DB.QueryContext(ctx, `
		UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1, updated_at = now()
		WHERE id IN (
			SELECT id FROM jobs
			WHERE status = 'queued' AND run_after <= now()
			ORDER BY created_at
			FOR UPDATE SKIP LOCKED
			LIMIT $2
		)
		RETURNING id::text, org_id::text, project_id::text, kind, payload_json, status, attempts, last_error, run_after, locked_at, locked_by, created_at, updated_at`,
		worker, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanJobs(rows)
}

func (s *Store) FinishJob(ctx context.Context, id, status, lastError string) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL, locked_by = '', updated_at = now()
		WHERE id = $1`, id, status, lastError)
	return err
}

func (s *Store) RequeueJob(ctx context.Context, id string, after time.Time, lastError string) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE jobs SET status = 'queued', run_after = $2, last_error = $3, locked_at = NULL, locked_by = '', updated_at = now()
		WHERE id = $1`, id, after, lastError)
	return err
}

func (s *Store) ListJobs(ctx context.Context, projectID string, limit int) ([]Job, error) {
	if limit <= 0 || limit > 100 {
		limit = 40
	}
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, org_id::text, project_id::text, kind, payload_json, status, attempts, last_error, run_after, locked_at, locked_by, created_at, updated_at
		FROM jobs
		WHERE ($1 = '' OR project_id::text = $1)
		ORDER BY created_at DESC
		LIMIT $2`, projectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanJobs(rows)
}

func scanJobs(rows *sql.Rows) ([]Job, error) {
	var out []Job
	for rows.Next() {
		var j Job
		var org, project sql.NullString
		var locked sql.NullTime
		if err := rows.Scan(&j.ID, &org, &project, &j.Kind, &j.PayloadJSON, &j.Status, &j.Attempts, &j.LastError, &j.RunAfter, &locked, &j.LockedBy, &j.CreatedAt, &j.UpdatedAt); err != nil {
			return nil, err
		}
		if org.Valid {
			j.OrgID = &org.String
		}
		if project.Valid {
			j.ProjectID = &project.String
		}
		if locked.Valid {
			j.LockedAt = &locked.Time
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

func (s *Store) RecordWebhook(ctx context.Context, ev WebhookEvent) (bool, error) {
	if ev.ID == "" {
		ev.ID = uuid.NewString()
	}
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO webhook_events (id, connection_id, project_id, provider, delivery_id, event_type, payload_hash)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (provider, delivery_id, payload_hash) DO NOTHING`,
		ev.ID, ev.ConnectionID, ev.ProjectID, ev.Provider, ev.DeliveryID, ev.EventType, ev.PayloadHash)
	if err != nil {
		return false, err
	}
	var n int
	if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_events WHERE id = $1`, ev.ID).Scan(&n); err != nil {
		return false, err
	}
	return n == 1, nil
}

func (s *Store) AcquireLease(ctx context.Context, lease EditLease) (*EditLease, error) {
	if lease.ID == "" {
		lease.ID = uuid.NewString()
	}
	_, _ = s.DB.ExecContext(ctx, `DELETE FROM edit_leases WHERE expires_at < now()`)
	var existingUser, existingToken string
	err := s.DB.QueryRowContext(ctx, `
		SELECT user_id::text, token FROM edit_leases WHERE project_id = $1 AND path = $2`, lease.ProjectID, lease.Path).
		Scan(&existingUser, &existingToken)
	if err == nil && existingUser != lease.UserID {
		return nil, errors.New("store: lease held by another user")
	}
	if err == nil && existingUser == lease.UserID {
		_, err = s.DB.ExecContext(ctx, `UPDATE edit_leases SET expires_at = $2, token = $3 WHERE project_id = $1 AND path = $4`,
			lease.ProjectID, lease.ExpiresAt, lease.Token, lease.Path)
		if err != nil {
			return nil, err
		}
		lease.Token = existingToken
		if lease.Token == "" {
			lease.Token = existingToken
		}
		return &lease, nil
	}
	if _, err := s.DB.ExecContext(ctx, `
		INSERT INTO edit_leases (id, project_id, path, user_id, token, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		lease.ID, lease.ProjectID, lease.Path, lease.UserID, lease.Token, lease.ExpiresAt); err != nil {
		return nil, err
	}
	return &lease, nil
}

func (s *Store) ReleaseLease(ctx context.Context, token string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM edit_leases WHERE token = $1`, token)
	return err
}

func (s *Store) LeaseByToken(ctx context.Context, token string) (*EditLease, error) {
	var l EditLease
	err := s.DB.QueryRowContext(ctx, `
		SELECT id::text, project_id::text, path, user_id::text, token, expires_at
		FROM edit_leases WHERE token = $1 AND expires_at > now()`, token).
		Scan(&l.ID, &l.ProjectID, &l.Path, &l.UserID, &l.Token, &l.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &l, nil
}

func (s *Store) CreateVersion(ctx context.Context, v DocVersion) (*DocVersion, error) {
	if v.ID == "" {
		v.ID = uuid.NewString()
	}
	err := s.DB.QueryRowContext(ctx, `
		INSERT INTO doc_versions (id, project_id, name, alias, git_ref, immutable)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
		v.ID, v.ProjectID, v.Name, v.Alias, v.GitRef, v.Immutable).
		Scan(&v.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func (s *Store) ListVersions(ctx context.Context, projectID string) ([]DocVersion, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, project_id::text, name, alias, git_ref, immutable, created_at
		FROM doc_versions WHERE project_id = $1 ORDER BY created_at DESC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DocVersion
	for rows.Next() {
		var v DocVersion
		if err := rows.Scan(&v.ID, &v.ProjectID, &v.Name, &v.Alias, &v.GitRef, &v.Immutable, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) GetVersion(ctx context.Context, projectID, name string) (*DocVersion, error) {
	var v DocVersion
	err := s.DB.QueryRowContext(ctx, `
		SELECT id::text, project_id::text, name, alias, git_ref, immutable, created_at
		FROM doc_versions WHERE project_id = $1 AND (name = $2 OR alias = $2)`, projectID, name).
		Scan(&v.ID, &v.ProjectID, &v.Name, &v.Alias, &v.GitRef, &v.Immutable, &v.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func (s *Store) CreatePublishRun(ctx context.Context, r PublishRun) (*PublishRun, error) {
	if r.ID == "" {
		r.ID = uuid.NewString()
	}
	if r.Status == "" {
		r.Status = "queued"
	}
	err := s.DB.QueryRowContext(ctx, `
		INSERT INTO publish_runs (id, project_id, target, version_name, status, artifact_path, public_url, error)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`,
		r.ID, r.ProjectID, r.Target, r.VersionName, r.Status, r.ArtifactPath, r.PublicURL, r.Error).
		Scan(&r.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) FinishPublishRun(ctx context.Context, id, status, artifact, publicURL, errText string) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE publish_runs SET status = $2, artifact_path = $3, public_url = $4, error = $5, finished_at = now()
		WHERE id = $1`, id, status, artifact, publicURL, errText)
	return err
}

func (s *Store) ListPublishRuns(ctx context.Context, projectID string) ([]PublishRun, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, project_id::text, target, version_name, status, artifact_path, public_url, error, created_at, finished_at
		FROM publish_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 40`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PublishRun
	for rows.Next() {
		var r PublishRun
		var finished sql.NullTime
		if err := rows.Scan(&r.ID, &r.ProjectID, &r.Target, &r.VersionName, &r.Status, &r.ArtifactPath, &r.PublicURL, &r.Error, &r.CreatedAt, &finished); err != nil {
			return nil, err
		}
		if finished.Valid {
			r.FinishedAt = &finished.Time
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) GetPublishRun(ctx context.Context, id string) (*PublishRun, error) {
	var r PublishRun
	var finished sql.NullTime
	err := s.DB.QueryRowContext(ctx, `
		SELECT id::text, project_id::text, target, version_name, status, artifact_path, public_url, error, created_at, finished_at
		FROM publish_runs WHERE id = $1`, id).
		Scan(&r.ID, &r.ProjectID, &r.Target, &r.VersionName, &r.Status, &r.ArtifactPath, &r.PublicURL, &r.Error, &r.CreatedAt, &finished)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if finished.Valid {
		r.FinishedAt = &finished.Time
	}
	return &r, nil
}

func (s *Store) UpsertSearchDocument(ctx context.Context, d SearchDocument) error {
	if d.ID == "" {
		d.ID = uuid.NewString()
	}
	if d.VersionName == "" {
		d.VersionName = "latest"
	}
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO search_documents (id, project_id, version_name, path, title, headings, body, keywords)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (project_id, version_name, path) DO UPDATE SET
			title = EXCLUDED.title, headings = EXCLUDED.headings, body = EXCLUDED.body, keywords = EXCLUDED.keywords`,
		d.ID, d.ProjectID, d.VersionName, d.Path, d.Title, d.Headings, d.Body, d.Keywords)
	return err
}

func (s *Store) ClearSearch(ctx context.Context, projectID, version string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM search_documents WHERE project_id = $1 AND version_name = $2`, projectID, version)
	return err
}

func (s *Store) SearchDocs(ctx context.Context, projectID, version, q string, limit int) ([]SearchDocument, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	if version == "" {
		version = "latest"
	}
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, project_id::text, version_name, path, title, headings, body, keywords
		FROM search_documents
		WHERE project_id = $1 AND version_name = $2 AND tsv @@ websearch_to_tsquery('english', $3)
		ORDER BY ts_rank(tsv, websearch_to_tsquery('english', $3)) DESC
		LIMIT $4`, projectID, version, q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SearchDocument
	for rows.Next() {
		var d SearchDocument
		if err := rows.Scan(&d.ID, &d.ProjectID, &d.VersionName, &d.Path, &d.Title, &d.Headings, &d.Body, &d.Keywords); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) CreateMapping(ctx context.Context, m MaintainerMapping) (*MaintainerMapping, error) {
	if m.ID == "" {
		m.ID = uuid.NewString()
	}
	if len(m.OptionsJSON) == 0 {
		m.OptionsJSON = []byte("{}")
	}
	err := s.DB.QueryRowContext(ctx, `
		INSERT INTO maintainer_mappings (id, project_id, source_match, extractor, output, options_json)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
		m.ID, m.ProjectID, m.SourceMatch, m.Extractor, m.Output, m.OptionsJSON).
		Scan(&m.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) ListMappings(ctx context.Context, projectID string) ([]MaintainerMapping, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, project_id::text, source_match, extractor, output, options_json, created_at
		FROM maintainer_mappings WHERE project_id = $1 ORDER BY created_at`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MaintainerMapping
	for rows.Next() {
		var m MaintainerMapping
		if err := rows.Scan(&m.ID, &m.ProjectID, &m.SourceMatch, &m.Extractor, &m.Output, &m.OptionsJSON, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) DeleteMapping(ctx context.Context, id string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM maintainer_mappings WHERE id = $1`, id)
	return err
}

func (s *Store) UpsertSnapshot(ctx context.Context, snap MaintainerSnapshot) error {
	if snap.ID == "" {
		snap.ID = uuid.NewString()
	}
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO maintainer_snapshots (id, project_id, source_path, source_sha, ir_json, updated_at)
		VALUES ($1,$2,$3,$4,$5, now())
		ON CONFLICT (project_id, source_path) DO UPDATE SET source_sha = EXCLUDED.source_sha, ir_json = EXCLUDED.ir_json, updated_at = now()`,
		snap.ID, snap.ProjectID, snap.SourcePath, snap.SourceSHA, snap.IRJSON)
	return err
}

func (s *Store) ListSnapshots(ctx context.Context, projectID string) ([]MaintainerSnapshot, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, project_id::text, source_path, source_sha, ir_json, updated_at
		FROM maintainer_snapshots WHERE project_id = $1`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MaintainerSnapshot
	for rows.Next() {
		var snap MaintainerSnapshot
		if err := rows.Scan(&snap.ID, &snap.ProjectID, &snap.SourcePath, &snap.SourceSHA, &snap.IRJSON, &snap.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, snap)
	}
	return out, rows.Err()
}

func (s *Store) UpsertRedirect(ctx context.Context, r Redirect) error {
	if r.ID == "" {
		r.ID = uuid.NewString()
	}
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO redirects (id, project_id, from_path, to_path) VALUES ($1,$2,$3,$4)
		ON CONFLICT (project_id, from_path) DO UPDATE SET to_path = EXCLUDED.to_path`,
		r.ID, r.ProjectID, r.FromPath, r.ToPath)
	return err
}

func (s *Store) ListRedirects(ctx context.Context, projectID string) ([]Redirect, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, project_id::text, from_path, to_path FROM redirects WHERE project_id = $1 ORDER BY from_path`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Redirect
	for rows.Next() {
		var r Redirect
		if err := rows.Scan(&r.ID, &r.ProjectID, &r.FromPath, &r.ToPath); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) CreateTeam(ctx context.Context, t Team) (*Team, error) {
	if t.ID == "" {
		t.ID = uuid.NewString()
	}
	_, err := s.DB.ExecContext(ctx, `INSERT INTO teams (id, org_id, name) VALUES ($1,$2,$3)`, t.ID, t.OrgID, t.Name)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *Store) ListTeams(ctx context.Context, orgID string) ([]Team, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id::text, org_id::text, name FROM teams WHERE org_id = $1 ORDER BY name`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Team
	for rows.Next() {
		var t Team
		if err := rows.Scan(&t.ID, &t.OrgID, &t.Name); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) AddTeamMember(ctx context.Context, teamID, userID string) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO team_memberships (team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, teamID, userID)
	return err
}

func (s *Store) ListTeamMembers(ctx context.Context, teamID string) ([]User, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT u.id::text, u.email, u.name, u.status
		FROM team_memberships tm JOIN users u ON u.id = tm.user_id
		WHERE tm.team_id = $1 ORDER BY u.name`, teamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.Status); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) CreateAPIToken(ctx context.Context, t APIToken) (*APIToken, error) {
	if t.ID == "" {
		t.ID = uuid.NewString()
	}
	err := s.DB.QueryRowContext(ctx, `
		INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
		t.ID, t.UserID, t.Name, t.TokenHash, pq.Array(t.Scopes), t.ExpiresAt).
		Scan(&t.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *Store) UserByAPIToken(ctx context.Context, tokenHash []byte) (*User, error) {
	row := s.DB.QueryRowContext(ctx, `
		SELECT u.id::text, u.email, u.name, u.password_hash, u.password_salt, u.status, u.instance_capabilities, u.last_login_at, u.created_at
		FROM api_tokens t
		JOIN users u ON u.id = t.user_id
		WHERE t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > now())`, tokenHash)
	user, err := s.scanUser(row)
	if err != nil {
		return nil, err
	}
	_, _ = s.DB.ExecContext(ctx, `UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1`, tokenHash)
	return user, nil
}

func (s *Store) DeleteAPIToken(ctx context.Context, userID, tokenHashHexName string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM api_tokens WHERE user_id = $1 AND name = $2`, userID, tokenHashHexName)
	return err
}

func PublicConnection(c GitConnection) map[string]any {
	return map[string]any{
		"id":           c.ID,
		"org_id":       c.OrgID,
		"provider":     c.Provider,
		"display_name": c.DisplayName,
		"base_url":     c.BaseURL,
		"auth_kind":    c.AuthKind,
		"created_at":   c.CreatedAt,
	}
}

func NullIfEmpty(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}
