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

	"lorelink.dev/lorelink/internal/access"
	"lorelink.dev/lorelink/internal/aspecmod"
)

func (s *Store) SeedASPEC(ctx context.Context) error {
	now := time.Now().UnixMilli()
	for _, p := range aspecmod.PermissionCatalog() {
		if _, err := s.DB.ExecContext(ctx, `
			INSERT INTO rbac_permissions (key, description, system, created_at, updated_at)
			VALUES ($1, $2, TRUE, $3, $3)
			ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, updated_at = EXCLUDED.updated_at`,
			p.Key, p.Description, now); err != nil {
			return err
		}
	}
	empty := []byte("[]")
	scopes := []byte(`["org","team"]`)
	for _, role := range aspecmod.SystemRoleDefs() {
		perms, err := json.Marshal(role.Permissions)
		if err != nil {
			return err
		}
		if _, err := s.DB.ExecContext(ctx, `
			INSERT INTO rbac_roles (key, name, description, permissions, denies, parents, assignable_scopes, system, version, created_at, updated_at)
			VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $5::jsonb, $6::jsonb, TRUE, 1, $7, $7)
			ON CONFLICT (key) DO UPDATE SET
				name = EXCLUDED.name,
				description = EXCLUDED.description,
				permissions = EXCLUDED.permissions,
				updated_at = EXCLUDED.updated_at`,
			role.Key, role.Name, role.Description, perms, empty, scopes, now); err != nil {
			return err
		}
	}
	if err := s.syncRBACAssignments(ctx, now); err != nil {
		return err
	}
	_, err := s.DB.ExecContext(ctx, `UPDATE users SET display_name = name WHERE display_name = ''`)
	return err
}

func (s *Store) syncRBACAssignments(ctx context.Context, now int64) error {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT m.user_id::text, m.org_id::text, r.name
		FROM org_memberships m
		JOIN roles r ON r.id = m.role_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var userID, orgID, roleName string
		if err := rows.Scan(&userID, &orgID, &roleName); err != nil {
			return err
		}
		if err := s.UpsertRBACAssignment(ctx, userID, aspecmod.RoleKey(roleName), orgID, "", now, nil); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	admins, err := s.DB.QueryContext(ctx, `
		SELECT id::text FROM users WHERE instance_capabilities @> ARRAY['instance.admin']`)
	if err != nil {
		return err
	}
	defer admins.Close()
	for admins.Next() {
		var userID string
		if err := admins.Scan(&userID); err != nil {
			return err
		}
		if err := s.UpsertRBACAssignment(ctx, userID, "instance-admin", "", "", now, nil); err != nil {
			return err
		}
	}
	return admins.Err()
}

func (s *Store) UpsertRBACAssignment(ctx context.Context, subjectID, roleKey, orgID, teamID string, now int64, createdBy *string) error {
	if now == 0 {
		now = time.Now().UnixMilli()
	}
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO rbac_assignments (id, subject_id, role_key, org_id, team_id, created_at, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (subject_id, role_key, org_id, team_id) DO NOTHING`,
		uuid.NewString(), subjectID, roleKey, orgID, teamID, now, createdBy)
	return err
}

func (s *Store) ListRBACPermissions(ctx context.Context) ([]aspecmod.Permission, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT key, COALESCE(description, ''), system FROM rbac_permissions ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []aspecmod.Permission
	for rows.Next() {
		var p aspecmod.Permission
		if err := rows.Scan(&p.Key, &p.Description, &p.System); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) ListRBACRoles(ctx context.Context) ([]RBACRole, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT key, name, COALESCE(description, ''), permissions, system, version
		FROM rbac_roles ORDER BY system DESC, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RBACRole
	for rows.Next() {
		var r RBACRole
		var raw []byte
		if err := rows.Scan(&r.Key, &r.Name, &r.Description, &raw, &r.System, &r.Version); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &r.Permissions)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) CreateOrgRole(ctx context.Context, orgID, name string, caps []access.Capability) (*Role, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("role name is required")
	}
	if len(caps) == 0 {
		return nil, errors.New("at least one capability is required")
	}
	id := uuid.NewString()
	now := time.Now().UnixMilli()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO roles (id, org_id, name, capabilities) VALUES ($1, $2, $3, $4)`,
		id, orgID, name, pq.Array(capsToStrings(caps))); err != nil {
		return nil, err
	}
	perms, err := json.Marshal(capsToStrings(caps))
	if err != nil {
		return nil, err
	}
	key := aspecmod.RoleKey(orgID + "-" + name)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO rbac_roles (key, name, description, permissions, denies, parents, assignable_scopes, system, version, created_at, updated_at)
		VALUES ($1, $2, $3, $4::jsonb, '[]'::jsonb, '[]'::jsonb, '["org"]'::jsonb, FALSE, 1, $5, $5)`,
		key, name, "Organisation role", perms, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &Role{ID: id, OrgID: &orgID, Name: name, Capabilities: caps}, nil
}

func (s *Store) ListOrgRoles(ctx context.Context, orgID string) ([]Role, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, org_id::text, name, capabilities
		FROM roles
		WHERE org_id IS NULL OR org_id = $1
		ORDER BY org_id NULLS FIRST, name`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Role
	for rows.Next() {
		var r Role
		var oid sql.NullString
		var caps []string
		if err := rows.Scan(&r.ID, &oid, &r.Name, pq.Array(&caps)); err != nil {
			return nil, err
		}
		if oid.Valid {
			r.OrgID = &oid.String
		}
		r.Capabilities = stringsToCaps(caps)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) ListRBACAssignments(ctx context.Context, orgID string) ([]RBACAssignment, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id, subject_id, role_key, org_id, team_id, created_at, created_by
		FROM rbac_assignments
		WHERE org_id = $1 OR ($1 = '' AND org_id = '')
		ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RBACAssignment
	for rows.Next() {
		var a RBACAssignment
		var createdBy sql.NullString
		if err := rows.Scan(&a.ID, &a.SubjectID, &a.RoleKey, &a.OrgID, &a.TeamID, &a.CreatedAt, &createdBy); err != nil {
			return nil, err
		}
		if createdBy.Valid {
			a.CreatedBy = &createdBy.String
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) AddMembership(ctx context.Context, orgID, userID, roleID string) error {
	role, err := s.RoleByID(ctx, roleID)
	if err != nil {
		return err
	}
	if role.OrgID != nil && *role.OrgID != orgID {
		return errors.New("role does not belong to this organisation")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO org_memberships (org_id, user_id, role_id) VALUES ($1, $2, $3)
		ON CONFLICT (org_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id`,
		orgID, userID, roleID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM rbac_assignments WHERE subject_id = $1 AND org_id = $2`, userID, orgID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO rbac_assignments (id, subject_id, role_key, org_id, team_id, created_at)
		VALUES ($1, $2, $3, $4, '', $5)`,
		uuid.NewString(), userID, aspecmod.RoleKey(role.Name), orgID, time.Now().UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SetMemberRole(ctx context.Context, orgID, userID, roleID string) error {
	role, err := s.RoleByID(ctx, roleID)
	if err != nil {
		return err
	}
	if role.OrgID != nil && *role.OrgID != orgID {
		return errors.New("role does not belong to this organisation")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `
		UPDATE org_memberships SET role_id = $3 WHERE org_id = $1 AND user_id = $2`, orgID, userID, roleID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM rbac_assignments WHERE subject_id = $1 AND org_id = $2`, userID, orgID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO rbac_assignments (id, subject_id, role_key, org_id, team_id, created_at)
		VALUES ($1, $2, $3, $4, '', $5)`,
		uuid.NewString(), userID, aspecmod.RoleKey(role.Name), orgID, time.Now().UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) RemoveMember(ctx context.Context, orgID, userID string) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM team_memberships WHERE user_id = $1 AND team_id IN (SELECT id FROM teams WHERE org_id = $2)`, userID, orgID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM org_memberships WHERE org_id = $1 AND user_id = $2`, orgID, userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM rbac_assignments WHERE subject_id = $1 AND org_id = $2`, userID, orgID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) CreateUser(ctx context.Context, u User) (*User, error) {
	if u.ID == "" {
		u.ID = uuid.NewString()
	}
	if u.Status == "" {
		u.Status = "active"
	}
	if u.DisplayName == "" {
		u.DisplayName = u.Name
	}
	err := s.DB.QueryRowContext(ctx, `
		INSERT INTO users (id, email, name, display_name, password_hash, password_salt, status, instance_capabilities)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING created_at`,
		u.ID, strings.ToLower(u.Email), u.Name, u.DisplayName, u.PasswordHash, u.PasswordSalt, u.Status, pq.Array(capsToStrings(u.InstanceCapabilities)),
	).Scan(&u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) UpdateUserProfile(ctx context.Context, userID, name, email string) error {
	name = strings.TrimSpace(name)
	email = strings.ToLower(strings.TrimSpace(email))
	_, err := s.DB.ExecContext(ctx, `
		UPDATE users SET name = COALESCE(NULLIF($2, ''), name), display_name = COALESCE(NULLIF($2, ''), display_name),
			email = COALESCE(NULLIF($3, ''), email), version = version + 1
		WHERE id = $1`, userID, name, email)
	return err
}

func (s *Store) SetUserPassword(ctx context.Context, userID string, hash, salt []byte) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE users SET password_hash = $2, password_salt = $3, version = version + 1 WHERE id = $1`, userID, hash, salt)
	return err
}

func (s *Store) SetUserStatus(ctx context.Context, userID, status, reason string, until *time.Time) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE users SET status = $2, suspend_reason = $3, suspended_until = $4, version = version + 1 WHERE id = $1`,
		userID, status, reason, until)
	return err
}

func (s *Store) SetInstanceAdmin(ctx context.Context, userID string, admin bool) error {
	var caps []string
	if admin {
		caps = capsToStrings(access.AllInstanceCapabilities())
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE users SET instance_capabilities = $2 WHERE id = $1`, userID, pq.Array(caps)); err != nil {
		return err
	}
	if admin {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO rbac_assignments (id, subject_id, role_key, org_id, team_id, created_at)
			VALUES ($1, $2, 'instance-admin', '', '', $3)
			ON CONFLICT (subject_id, role_key, org_id, team_id) DO NOTHING`,
			uuid.NewString(), userID, time.Now().UnixMilli()); err != nil {
			return err
		}
	} else if _, err := tx.ExecContext(ctx, `
		DELETE FROM rbac_assignments WHERE subject_id = $1 AND role_key = 'instance-admin' AND org_id = ''`, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListUserAccounts(ctx context.Context) ([]User, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id::text, email, name, display_name, status, instance_capabilities, suspend_reason, suspended_until, last_login_at, created_at
		FROM users ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		var caps []string
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.DisplayName, &u.Status, pq.Array(&caps), &u.SuspendReason, &u.SuspendedUntil, &u.LastLoginAt, &u.CreatedAt); err != nil {
			return nil, err
		}
		u.InstanceCapabilities = stringsToCaps(caps)
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) RecordLoginFailure(ctx context.Context, email string, maxFails int, lockFor time.Duration) (locked bool, until *time.Time, err error) {
	email = strings.ToLower(strings.TrimSpace(email))
	var count int
	var lockedUntil sql.NullTime
	err = s.DB.QueryRowContext(ctx, `
		INSERT INTO auth_lockouts (id, email, failed_count, updated_at)
		VALUES ($1, $2, 1, now())
		ON CONFLICT (email) DO UPDATE SET
			failed_count = CASE
				WHEN auth_lockouts.locked_until IS NOT NULL AND auth_lockouts.locked_until > now() THEN auth_lockouts.failed_count
				WHEN auth_lockouts.updated_at < now() - interval '15 minutes' THEN 1
				ELSE auth_lockouts.failed_count + 1
			END,
			updated_at = now()
		RETURNING failed_count, locked_until`, uuid.NewString(), email).Scan(&count, &lockedUntil)
	if err != nil {
		return false, nil, err
	}
	if lockedUntil.Valid && lockedUntil.Time.After(time.Now()) {
		t := lockedUntil.Time
		return true, &t, nil
	}
	if count >= maxFails {
		untilTime := time.Now().Add(lockFor)
		if _, err := s.DB.ExecContext(ctx, `UPDATE auth_lockouts SET locked_until = $2, failed_count = 0 WHERE email = $1`, email, untilTime); err != nil {
			return false, nil, err
		}
		return true, &untilTime, nil
	}
	return false, nil, nil
}

func (s *Store) ClearLoginFailures(ctx context.Context, email string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM auth_lockouts WHERE email = $1`, strings.ToLower(strings.TrimSpace(email)))
	return err
}

func (s *Store) IsLocked(ctx context.Context, email string) (bool, *time.Time, error) {
	var until sql.NullTime
	err := s.DB.QueryRowContext(ctx, `
		SELECT locked_until FROM auth_lockouts WHERE email = $1 AND locked_until > now()`,
		strings.ToLower(strings.TrimSpace(email))).Scan(&until)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil, nil
	}
	if err != nil {
		return false, nil, err
	}
	if until.Valid {
		t := until.Time
		return true, &t, nil
	}
	return false, nil, nil
}

func (s *Store) CreateResetToken(ctx context.Context, userID string, tokenHash []byte, createdBy *string, ttl time.Duration) error {
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO auth_reset_tokens (id, user_id, token_hash, created_by, expires_at)
		VALUES ($1, $2, $3, $4, $5)`,
		uuid.NewString(), userID, tokenHash, createdBy, time.Now().Add(ttl))
	return err
}

func (s *Store) ConsumeResetToken(ctx context.Context, tokenHash []byte) (string, error) {
	var userID string
	err := s.DB.QueryRowContext(ctx, `
		UPDATE auth_reset_tokens
		SET used_at = now()
		WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		RETURNING user_id::text`, tokenHash).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return userID, err
}

func (s *Store) CreateAPIKey(ctx context.Context, k APIKey) (*APIKey, error) {
	if k.ID == "" {
		k.ID = uuid.NewString()
	}
	if k.Status == "" {
		k.Status = "active"
	}
	if k.OwnerType == "" {
		k.OwnerType = "user"
	}
	now := time.Now().UnixMilli()
	k.CreatedAt = now
	k.UpdatedAt = now
	scopes, err := json.Marshal(k.Scopes)
	if err != nil {
		return nil, err
	}
	if k.Scopes == nil {
		scopes = []byte("[]")
	}
	_, err = s.DB.ExecContext(ctx, `
		INSERT INTO api_keys_keys (
			id, public_id, key_hash, display_prefix, prefix, name, scopes, status, owner_type, owner_id, org_id, metadata, created_at, updated_at, use_count
		) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'{}'::jsonb,$12,$12,0)`,
		k.ID, k.PublicID, k.KeyHash, k.DisplayPrefix, aspecmod.DefaultKeyPrefix, k.Name, scopes, k.Status, k.OwnerType, k.OwnerID, k.OrgID, now)
	if err != nil {
		return nil, err
	}
	return &k, nil
}

func (s *Store) ListAPIKeys(ctx context.Context, ownerID string) ([]APIKey, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id, public_id, display_prefix, name, scopes, status, owner_type, owner_id, org_id, expires_at, revoked_at, COALESCE(revoked_reason, ''), created_at, updated_at, last_used_at, use_count
		FROM api_keys_keys
		WHERE owner_id = $1
		ORDER BY created_at DESC`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []APIKey
	for rows.Next() {
		var k APIKey
		var raw []byte
		var orgID sql.NullString
		var expires, revoked, lastUsed sql.NullInt64
		if err := rows.Scan(&k.ID, &k.PublicID, &k.DisplayPrefix, &k.Name, &raw, &k.Status, &k.OwnerType, &k.OwnerID, &orgID, &expires, &revoked, &k.RevokedReason, &k.CreatedAt, &k.UpdatedAt, &lastUsed, &k.UseCount); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &k.Scopes)
		if orgID.Valid {
			k.OrgID = &orgID.String
		}
		if expires.Valid {
			k.ExpiresAt = &expires.Int64
		}
		if revoked.Valid {
			k.RevokedAt = &revoked.Int64
		}
		if lastUsed.Valid {
			k.LastUsedAt = &lastUsed.Int64
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *Store) GetAPIKey(ctx context.Context, id, ownerID string) (*APIKey, error) {
	var k APIKey
	var raw []byte
	var orgID sql.NullString
	err := s.DB.QueryRowContext(ctx, `
		SELECT id, public_id, display_prefix, name, scopes, status, owner_type, owner_id, org_id, created_at, updated_at, key_hash
		FROM api_keys_keys WHERE id = $1 AND owner_id = $2`, id, ownerID).
		Scan(&k.ID, &k.PublicID, &k.DisplayPrefix, &k.Name, &raw, &k.Status, &k.OwnerType, &k.OwnerID, &orgID, &k.CreatedAt, &k.UpdatedAt, &k.KeyHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(raw, &k.Scopes)
	if orgID.Valid {
		k.OrgID = &orgID.String
	}
	return &k, nil
}

func (s *Store) RevokeAPIKey(ctx context.Context, id, ownerID, reason, revokedBy string) error {
	now := time.Now().UnixMilli()
	res, err := s.DB.ExecContext(ctx, `
		UPDATE api_keys_keys
		SET status = 'revoked', revoked_at = $3, revoked_reason = $4, revoked_by = $5, updated_at = $3
		WHERE id = $1 AND owner_id = $2 AND status = 'active'`,
		id, ownerID, now, reason, revokedBy)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RotateAPIKey(ctx context.Context, id, ownerID, newHash, displayPrefix, publicID string, graceMs int64) error {
	now := time.Now().UnixMilli()
	prevExpires := now + graceMs
	res, err := s.DB.ExecContext(ctx, `
		UPDATE api_keys_keys
		SET previous_key_hash = key_hash, previous_expires_at = $4, key_hash = $3,
			display_prefix = $5, public_id = $6, updated_at = $7
		WHERE id = $1 AND owner_id = $2 AND status = 'active'`,
		id, ownerID, newHash, prevExpires, displayPrefix, publicID, now)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) UserByAPIKeyHash(ctx context.Context, keyHash, ip string) (*User, error) {
	now := time.Now().UnixMilli()
	row := s.DB.QueryRowContext(ctx, `
		SELECT u.id::text, u.email, u.name, u.password_hash, u.password_salt, u.status, u.instance_capabilities, u.last_login_at, u.created_at, k.id
		FROM api_keys_keys k
		JOIN users u ON u.id::text = k.owner_id
		WHERE k.owner_type = 'user'
		  AND k.status = 'active'
		  AND u.status = 'active'
		  AND (k.key_hash = $1 OR (k.previous_key_hash = $1 AND (k.previous_expires_at IS NULL OR k.previous_expires_at > $2)))
		  AND (k.expires_at IS NULL OR k.expires_at > $2)`, keyHash, now)
	var u User
	var caps []string
	var keyID string
	err := row.Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.PasswordSalt, &u.Status, pq.Array(&caps), &u.LastLoginAt, &u.CreatedAt, &keyID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.InstanceCapabilities = stringsToCaps(caps)
	_, _ = s.DB.ExecContext(ctx, `
		UPDATE api_keys_keys SET last_used_at = $2, last_used_ip = $3, use_count = use_count + 1 WHERE id = $1`,
		keyID, now, ip)
	return &u, nil
}

func (s *Store) RecordUserActivity(ctx context.Context, userID, typ, actorID, ip, userAgent string) error {
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO users_activity (id, user_id, type, at, actor_id, ip, user_agent, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)`,
		uuid.NewString(), userID, typ, time.Now().UnixMilli(), nilIfEmpty(actorID), ip, userAgent)
	return err
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
