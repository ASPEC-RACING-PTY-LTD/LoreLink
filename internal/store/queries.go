package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"lorelink.dev/lorelink/internal/access"
)

var ErrNotFound = errors.New("store: not found")

func (s *Store) GetInstance(ctx context.Context) (*Instance, error) {
	row := s.DB.QueryRowContext(ctx, `
		SELECT id::text, name, public_base_url, portal_enabled, setup_completed_at, created_at
		FROM instances
		ORDER BY created_at ASC
		LIMIT 1`)
	var inst Instance
	err := row.Scan(&inst.ID, &inst.Name, &inst.PublicBaseURL, &inst.PortalEnabled, &inst.SetupCompletedAt, &inst.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &inst, nil
}

func (s *Store) SetupCompleted(ctx context.Context) (bool, error) {
	inst, err := s.GetInstance(ctx)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return inst.SetupCompletedAt != nil, nil
}

func (s *Store) CreateSetup(ctx context.Context, inst Instance, user User, org Organisation, roleName string) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	now := time.Now().UTC()
	if inst.ID == "" {
		inst.ID = uuid.NewString()
	}
	if user.ID == "" {
		user.ID = uuid.NewString()
	}
	if org.ID == "" {
		org.ID = uuid.NewString()
	}
	completed := now
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO instances (id, name, public_base_url, portal_enabled, setup_completed_at, created_at)
		VALUES ($1, $2, $3, TRUE, $4, $5)`,
		inst.ID, inst.Name, inst.PublicBaseURL, completed, now); err != nil {
		return fmt.Errorf("insert instance: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (id, email, name, password_hash, password_salt, status, instance_capabilities, created_at)
		VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)`,
		user.ID, strings.ToLower(user.Email), user.Name, user.PasswordHash, user.PasswordSalt,
		pq.Array(capsToStrings(access.AllInstanceCapabilities())), now); err != nil {
		return fmt.Errorf("insert user: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO organisations (id, slug, name, created_at)
		VALUES ($1, $2, $3, $4)`,
		org.ID, org.Slug, org.Name, now); err != nil {
		return fmt.Errorf("insert org: %w", err)
	}
	var roleID string
	if err := tx.QueryRowContext(ctx, `
		SELECT id::text FROM roles WHERE org_id IS NULL AND name = $1`, roleName).Scan(&roleID); err != nil {
		return fmt.Errorf("lookup role %s: %w", roleName, err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO org_memberships (org_id, user_id, role_id)
		VALUES ($1, $2, $3)`, org.ID, user.ID, roleID); err != nil {
		return fmt.Errorf("insert membership: %w", err)
	}
	return tx.Commit()
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	return s.scanUser(s.DB.QueryRowContext(ctx, `
		SELECT id::text, email, name, password_hash, password_salt, status, instance_capabilities, last_login_at, created_at
		FROM users WHERE email = $1`, strings.ToLower(email)))
}

func (s *Store) GetUser(ctx context.Context, id string) (*User, error) {
	return s.scanUser(s.DB.QueryRowContext(ctx, `
		SELECT id::text, email, name, password_hash, password_salt, status, instance_capabilities, last_login_at, created_at
		FROM users WHERE id = $1`, id))
}

func (s *Store) scanUser(row *sql.Row) (*User, error) {
	var u User
	var caps []string
	err := row.Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.PasswordSalt, &u.Status, pq.Array(&caps), &u.LastLoginAt, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.InstanceCapabilities = stringsToCaps(caps)
	return &u, nil
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, email, name, password_hash, password_salt, status, instance_capabilities, last_login_at, created_at
		FROM users ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		var caps []string
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.PasswordSalt, &u.Status, pq.Array(&caps), &u.LastLoginAt, &u.CreatedAt); err != nil {
			return nil, err
		}
		u.InstanceCapabilities = stringsToCaps(caps)
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) TouchLogin(ctx context.Context, userID string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE users SET last_login_at = now() WHERE id = $1`, userID)
	return err
}

func HashToken(token []byte) []byte {
	sum := sha256.Sum256(token)
	return sum[:]
}

func (s *Store) CreateSession(ctx context.Context, sess Session) error {
	if sess.ID == "" {
		sess.ID = uuid.NewString()
	}
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent, ip)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		sess.ID, sess.UserID, sess.TokenHash, sess.ExpiresAt, sess.UserAgent, sess.IP)
	return err
}

func (s *Store) SessionUser(ctx context.Context, tokenHash []byte) (*User, error) {
	row := s.DB.QueryRowContext(ctx, `
		SELECT u.id::text, u.email, u.name, u.password_hash, u.password_salt, u.status, u.instance_capabilities, u.last_login_at, u.created_at
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.expires_at > now()`, tokenHash)
	return s.scanUser(row)
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash []byte) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
	return err
}

func (s *Store) ListOrganisationsForUser(ctx context.Context, userID string) ([]Organisation, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT o.id::text, o.slug, o.name, o.created_at
		FROM organisations o
		JOIN org_memberships m ON m.org_id = o.id
		WHERE m.user_id = $1
		ORDER BY o.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Organisation
	for rows.Next() {
		var o Organisation
		if err := rows.Scan(&o.ID, &o.Slug, &o.Name, &o.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (s *Store) GetOrganisation(ctx context.Context, id string) (*Organisation, error) {
	var o Organisation
	err := s.DB.QueryRowContext(ctx, `
		SELECT id::text, slug, name, created_at FROM organisations WHERE id = $1`, id).
		Scan(&o.ID, &o.Slug, &o.Name, &o.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

func (s *Store) Membership(ctx context.Context, orgID, userID string) (*Membership, error) {
	var m Membership
	var caps []string
	err := s.DB.QueryRowContext(ctx, `
		SELECT m.org_id::text, m.user_id::text, m.role_id::text, r.name, r.capabilities
		FROM org_memberships m
		JOIN roles r ON r.id = m.role_id
		WHERE m.org_id = $1 AND m.user_id = $2`, orgID, userID).
		Scan(&m.OrgID, &m.UserID, &m.RoleID, &m.Role.Name, pq.Array(&caps))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	m.Role.ID = m.RoleID
	m.Role.Capabilities = stringsToCaps(caps)
	return &m, nil
}

func (s *Store) ListMembers(ctx context.Context, orgID string) ([]struct {
	User User
	Role Role
}, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT u.id::text, u.email, u.name, u.status, u.instance_capabilities, r.id::text, r.name, r.capabilities
		FROM org_memberships m
		JOIN users u ON u.id = m.user_id
		JOIN roles r ON r.id = m.role_id
		WHERE m.org_id = $1
		ORDER BY u.name`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []struct {
		User User
		Role Role
	}
	for rows.Next() {
		var item struct {
			User User
			Role Role
		}
		var icaps, rcaps []string
		if err := rows.Scan(&item.User.ID, &item.User.Email, &item.User.Name, &item.User.Status, pq.Array(&icaps), &item.Role.ID, &item.Role.Name, pq.Array(&rcaps)); err != nil {
			return nil, err
		}
		item.User.InstanceCapabilities = stringsToCaps(icaps)
		item.Role.Capabilities = stringsToCaps(rcaps)
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) RoleByName(ctx context.Context, name string) (*Role, error) {
	var r Role
	var caps []string
	err := s.DB.QueryRowContext(ctx, `
		SELECT id::text, name, capabilities FROM roles WHERE org_id IS NULL AND name = $1`, name).
		Scan(&r.ID, &r.Name, pq.Array(&caps))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	r.Capabilities = stringsToCaps(caps)
	return &r, nil
}

func (s *Store) RoleByID(ctx context.Context, id string) (*Role, error) {
	var r Role
	var caps []string
	err := s.DB.QueryRowContext(ctx, `
		SELECT id::text, name, capabilities FROM roles WHERE id = $1`, id).
		Scan(&r.ID, &r.Name, pq.Array(&caps))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	r.Capabilities = stringsToCaps(caps)
	return &r, nil
}

func (s *Store) ListSystemRoles(ctx context.Context) ([]Role, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, name, capabilities FROM roles WHERE org_id IS NULL ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Role
	for rows.Next() {
		var r Role
		var caps []string
		if err := rows.Scan(&r.ID, &r.Name, pq.Array(&caps)); err != nil {
			return nil, err
		}
		r.Capabilities = stringsToCaps(caps)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) CreateInvitation(ctx context.Context, inv Invitation) error {
	if inv.ID == "" {
		inv.ID = uuid.NewString()
	}
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO invitations (id, org_id, email, role_id, token_hash, expires_at, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		inv.ID, inv.OrgID, strings.ToLower(inv.Email), inv.RoleID, inv.TokenHash, inv.ExpiresAt, nil)
	return err
}

func (s *Store) InvitationByTokenHash(ctx context.Context, tokenHash []byte) (*Invitation, error) {
	var inv Invitation
	err := s.DB.QueryRowContext(ctx, `
		SELECT id::text, org_id::text, email, role_id::text, token_hash, expires_at, accepted_at
		FROM invitations WHERE token_hash = $1`, tokenHash).
		Scan(&inv.ID, &inv.OrgID, &inv.Email, &inv.RoleID, &inv.TokenHash, &inv.ExpiresAt, &inv.AcceptedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &inv, nil
}

func (s *Store) AcceptInvitation(ctx context.Context, inv Invitation, user User) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if user.ID == "" {
		user.ID = uuid.NewString()
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (id, email, name, password_hash, password_salt, status, instance_capabilities)
		VALUES ($1, $2, $3, $4, $5, 'active', '{}')`,
		user.ID, strings.ToLower(user.Email), user.Name, user.PasswordHash, user.PasswordSalt); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO org_memberships (org_id, user_id, role_id)
		VALUES ($1, $2, $3)`, inv.OrgID, user.ID, inv.RoleID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE invitations SET accepted_at = now() WHERE id = $1`, inv.ID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) CreateProject(ctx context.Context, p Project) (*Project, error) {
	if p.ID == "" {
		p.ID = uuid.NewString()
	}
	if p.DocsRoot == "" {
		p.DocsRoot = "docs"
	}
	if p.DefaultBranch == "" {
		p.DefaultBranch = "main"
	}
	if p.PublishPolicy == "" {
		p.PublishPolicy = "manual"
	}
	if p.Visibility == "" {
		p.Visibility = "private"
	}
	err := s.DB.QueryRowContext(ctx, `
		INSERT INTO projects (id, org_id, name, slug, description, visibility, docs_root, default_branch, publish_policy)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING created_at`,
		p.ID, p.OrgID, p.Name, p.Slug, p.Description, p.Visibility, p.DocsRoot, p.DefaultBranch, p.PublishPolicy).
		Scan(&p.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) ListProjects(ctx context.Context, orgID string) ([]Project, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, org_id::text, name, slug, description, visibility, docs_root, default_branch, publish_policy, created_at
		FROM projects WHERE org_id = $1 ORDER BY name`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Project
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.OrgID, &p.Name, &p.Slug, &p.Description, &p.Visibility, &p.DocsRoot, &p.DefaultBranch, &p.PublishPolicy, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) WriteAudit(ctx context.Context, ev AuditEvent) error {
	if ev.ID == "" {
		ev.ID = uuid.NewString()
	}
	if len(ev.Metadata) == 0 {
		ev.Metadata = []byte("{}")
	}
	if !json.Valid(ev.Metadata) {
		ev.Metadata = []byte("{}")
	}
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO audit_events (id, actor_user_id, org_id, project_id, action, target, metadata_json, ip)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		ev.ID, ev.ActorUserID, ev.OrgID, ev.ProjectID, ev.Action, ev.Target, ev.Metadata, ev.IP)
	return err
}

func (s *Store) ListAudit(ctx context.Context, orgID string, limit int) ([]AuditEvent, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, actor_user_id::text, org_id::text, project_id::text, action, target, metadata_json, ip, created_at
		FROM audit_events
		WHERE ($1 = '' OR org_id::text = $1)
		ORDER BY created_at DESC
		LIMIT $2`, orgID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEvent
	for rows.Next() {
		var ev AuditEvent
		var actor, org, project sql.NullString
		if err := rows.Scan(&ev.ID, &actor, &org, &project, &ev.Action, &ev.Target, &ev.Metadata, &ev.IP, &ev.CreatedAt); err != nil {
			return nil, err
		}
		if actor.Valid {
			ev.ActorUserID = &actor.String
		}
		if org.Valid {
			ev.OrgID = &org.String
		}
		if project.Valid {
			ev.ProjectID = &project.String
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}

func capsToStrings(in []access.Capability) []string {
	out := make([]string, len(in))
	for i, c := range in {
		out[i] = string(c)
	}
	return out
}

func stringsToCaps(in []string) []access.Capability {
	out := make([]access.Capability, 0, len(in))
	for _, c := range in {
		out = append(out, access.Capability(c))
	}
	return out
}
