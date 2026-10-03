package api

import (
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"lorelink.dev/lorelink/internal/access"
	"lorelink.dev/lorelink/internal/aspecmod"
	"lorelink.dev/lorelink/internal/identity"
	"lorelink.dev/lorelink/internal/store"
)

const (
	lockoutFails = 5
	lockoutFor   = 15 * time.Minute
	resetTTL     = 2 * time.Hour
	rotateGrace  = 24 * time.Hour
)

func (s *Server) mountASPEC(r chi.Router) {
	r.With(s.limit("reset", 20, time.Hour)).Post("/auth/reset", s.authReset)

	r.Group(func(r chi.Router) {
		r.Use(s.requireSession)
		r.Use(s.csrf)
		r.Get("/me/api-keys", s.apiKeysList)
		r.Post("/me/api-keys", s.apiKeysCreate)
		r.Post("/me/api-keys/{keyID}/rotate", s.apiKeysRotate)
		r.Delete("/me/api-keys/{keyID}", s.apiKeysRevoke)

		r.Post("/instance/users", s.instanceUserCreate)
		r.Patch("/instance/users/{userID}", s.instanceUserPatch)
		r.Post("/instance/users/{userID}/suspend", s.instanceUserSuspend)
		r.Post("/instance/users/{userID}/activate", s.instanceUserActivate)
		r.Post("/instance/users/{userID}/password-reset", s.instanceUserReset)
		r.Post("/instance/users/{userID}/instance-admin", s.instanceUserAdmin)

		r.Get("/rbac/permissions", s.rbacPermissions)
		r.Get("/rbac/roles", s.rbacRoles)
		r.Get("/orgs/{orgID}/roles", s.orgRoles)
		r.Post("/orgs/{orgID}/roles", s.orgRoleCreate)
		r.Get("/orgs/{orgID}/rbac/assignments", s.orgAssignments)
		r.Patch("/orgs/{orgID}/members/{userID}", s.orgMemberPatch)
		r.Delete("/orgs/{orgID}/members/{userID}", s.orgMemberDelete)
	})
}

func (s *Server) requireUserAdmin(w http.ResponseWriter, r *http.Request) (*store.User, bool) {
	user := userFrom(r.Context())
	if user == nil {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "authentication required")
		return nil, false
	}
	if !access.Has(user.InstanceCapabilities, access.CapInstanceAdmin) && !access.Has(user.InstanceCapabilities, access.CapInstanceUsersManage) {
		writeError(w, http.StatusForbidden, "forbidden", "user management requires instance.users.manage")
		return nil, false
	}
	return user, true
}

func (s *Server) instanceUserCreate(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireUserAdmin(w, r)
	if !ok {
		return
	}
	var body struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Password string `json:"password"`
		OrgID    string `json:"org_id"`
		RoleID   string `json:"role_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	name := strings.TrimSpace(body.Name)
	if !validEmail(email) || name == "" {
		writeError(w, http.StatusBadRequest, "validation", "name and a valid email are required")
		return
	}
	if len(body.Password) < minPasswordLen {
		writeError(w, http.StatusBadRequest, "validation", "password must be at least 10 characters")
		return
	}
	hash, salt, err := identity.HashPassword(body.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not hash password")
		return
	}
	created, err := s.Store.CreateUser(r.Context(), store.User{
		Email:        email,
		Name:         name,
		DisplayName:  name,
		PasswordHash: hash,
		PasswordSalt: salt,
		Status:       "active",
	})
	if err != nil {
		writeError(w, http.StatusConflict, "conflict", "could not create user")
		return
	}
	if orgID := strings.TrimSpace(body.OrgID); orgID != "" {
		roleID := strings.TrimSpace(body.RoleID)
		if roleID == "" {
			if role, rerr := s.Store.RoleByName(r.Context(), "Writer"); rerr == nil {
				roleID = role.ID
			}
		}
		if roleID != "" {
			if err := s.Store.AddMembership(r.Context(), orgID, created.ID, roleID); err != nil {
				writeError(w, http.StatusBadRequest, "validation", "user created, but organisation membership failed")
				return
			}
		}
	}
	_ = s.Store.RecordUserActivity(r.Context(), created.ID, "user.created", actor.ID, clientIP(r), r.UserAgent())
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &actor.ID, Action: "users.create", Target: created.Email, IP: clientIP(r)})
	writeJSON(w, http.StatusCreated, publicUser(created))
}

func (s *Server) instanceUserPatch(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireUserAdmin(w, r)
	if !ok {
		return
	}
	var body struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	userID := chi.URLParam(r, "userID")
	if err := s.Store.UpdateUserProfile(r.Context(), userID, body.Name, body.Email); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not update user")
		return
	}
	user, err := s.Store.GetUser(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "user not found")
		return
	}
	_ = s.Store.RecordUserActivity(r.Context(), userID, "user.updated", actor.ID, clientIP(r), r.UserAgent())
	writeJSON(w, http.StatusOK, publicUser(user))
}

func (s *Server) instanceUserSuspend(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireUserAdmin(w, r)
	if !ok {
		return
	}
	targetID := chi.URLParam(r, "userID")
	if targetID == actor.ID {
		writeError(w, http.StatusBadRequest, "validation", "you cannot suspend your own account")
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := s.Store.SetUserStatus(r.Context(), targetID, "suspended", strings.TrimSpace(body.Reason), nil); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not suspend user")
		return
	}
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &actor.ID, Action: "users.suspend", Target: targetID, IP: clientIP(r)})
	user, _ := s.Store.GetUser(r.Context(), targetID)
	writeJSON(w, http.StatusOK, publicUser(user))
}

func (s *Server) instanceUserActivate(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireUserAdmin(w, r)
	if !ok {
		return
	}
	targetID := chi.URLParam(r, "userID")
	if err := s.Store.SetUserStatus(r.Context(), targetID, "active", "", nil); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not activate user")
		return
	}
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &actor.ID, Action: "users.activate", Target: targetID, IP: clientIP(r)})
	user, _ := s.Store.GetUser(r.Context(), targetID)
	writeJSON(w, http.StatusOK, publicUser(user))
}

func (s *Server) instanceUserReset(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireUserAdmin(w, r)
	if !ok {
		return
	}
	targetID := chi.URLParam(r, "userID")
	if _, err := s.Store.GetUser(r.Context(), targetID); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "user not found")
		return
	}
	raw, err := randomToken(24)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not create reset token")
		return
	}
	if err := s.Store.CreateResetToken(r.Context(), targetID, store.HashToken(raw), &actor.ID, resetTTL); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not store reset token")
		return
	}
	token := hex.EncodeToString(raw)
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &actor.ID, Action: "auth.password_reset.issued", Target: targetID, IP: clientIP(r)})
	writeJSON(w, http.StatusCreated, map[string]any{"token": token, "path": "/reset/" + token})
}

func (s *Server) instanceUserAdmin(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireUserAdmin(w, r)
	if !ok {
		return
	}
	if !access.Has(actor.InstanceCapabilities, access.CapInstanceAdmin) {
		writeError(w, http.StatusForbidden, "forbidden", "granting instance.admin requires instance.admin")
		return
	}
	var body struct {
		Admin bool `json:"admin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	targetID := chi.URLParam(r, "userID")
	if targetID == actor.ID && !body.Admin {
		writeError(w, http.StatusBadRequest, "validation", "you cannot remove your own instance.admin grant")
		return
	}
	if err := s.Store.SetInstanceAdmin(r.Context(), targetID, body.Admin); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not update instance grant")
		return
	}
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &actor.ID, Action: "users.instance_admin", Target: targetID, IP: clientIP(r)})
	user, _ := s.Store.GetUser(r.Context(), targetID)
	writeJSON(w, http.StatusOK, publicUser(user))
}

func (s *Server) authReset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	raw, err := hex.DecodeString(strings.TrimSpace(body.Token))
	if err != nil {
		writeError(w, http.StatusBadRequest, "validation", "reset token is invalid")
		return
	}
	if len(body.Password) < minPasswordLen {
		writeError(w, http.StatusBadRequest, "validation", "password must be at least 10 characters")
		return
	}
	userID, err := s.Store.ConsumeResetToken(r.Context(), store.HashToken(raw))
	if err != nil {
		writeError(w, http.StatusGone, "expired", "reset token is invalid or expired")
		return
	}
	hash, salt, err := identity.HashPassword(body.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not hash password")
		return
	}
	if err := s.Store.SetUserPassword(r.Context(), userID, hash, salt); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not update password")
		return
	}
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{Action: "auth.password_reset", Target: userID, IP: clientIP(r)})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) apiKeysList(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	keys, err := s.Store.ListAPIKeys(r.Context(), user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list API keys")
		return
	}
	if keys == nil {
		keys = []store.APIKey{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

func (s *Server) apiKeysCreate(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	if len(s.APIKeyPepper) == 0 {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "API key pepper is not configured")
		return
	}
	var body struct {
		Name   string   `json:"name"`
		Scopes []string `json:"scopes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = "key-" + time.Now().UTC().Format("20060102-150405")
	}
	parts, err := aspecmod.GenerateKey()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not generate API key")
		return
	}
	created, err := s.Store.CreateAPIKey(r.Context(), store.APIKey{
		PublicID:      parts.PublicID,
		DisplayPrefix: parts.DisplayPrefix,
		Name:          name,
		Scopes:        body.Scopes,
		OwnerType:     "user",
		OwnerID:       user.ID,
		KeyHash:       aspecmod.HashKey(s.APIKeyPepper, parts.Key),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not store API key")
		return
	}
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &user.ID, Action: "api_keys.create", Target: created.ID, IP: clientIP(r)})
	out := *created
	out.Secret = parts.Key
	writeJSON(w, http.StatusCreated, out)
}

func (s *Server) apiKeysRevoke(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	if err := s.Store.RevokeAPIKey(r.Context(), chi.URLParam(r, "keyID"), user.ID, "revoked", user.ID); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "API key not found")
		return
	}
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &user.ID, Action: "api_keys.revoke", Target: chi.URLParam(r, "keyID"), IP: clientIP(r)})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) apiKeysRotate(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	if len(s.APIKeyPepper) == 0 {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "API key pepper is not configured")
		return
	}
	parts, err := aspecmod.GenerateKey()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not generate API key")
		return
	}
	if err := s.Store.RotateAPIKey(r.Context(), chi.URLParam(r, "keyID"), user.ID, aspecmod.HashKey(s.APIKeyPepper, parts.Key), parts.DisplayPrefix, parts.PublicID, rotateGrace.Milliseconds()); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "API key not found")
		return
	}
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &user.ID, Action: "api_keys.rotate", Target: chi.URLParam(r, "keyID"), IP: clientIP(r)})
	writeJSON(w, http.StatusOK, map[string]any{"secret": parts.Key, "display_prefix": parts.DisplayPrefix, "public_id": parts.PublicID})
}

func (s *Server) rbacPermissions(w http.ResponseWriter, r *http.Request) {
	perms, err := s.Store.ListRBACPermissions(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list permissions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"permissions": perms})
}

func (s *Server) rbacRoles(w http.ResponseWriter, r *http.Request) {
	roles, err := s.Store.ListRBACRoles(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list roles")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": roles})
}

func (s *Server) orgRoles(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.orgActor(w, r, access.CapOrgView); !ok {
		return
	}
	roles, err := s.Store.ListOrgRoles(r.Context(), chi.URLParam(r, "orgID"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list roles")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": roles})
}

func (s *Server) orgRoleCreate(w http.ResponseWriter, r *http.Request) {
	_, org, ok := s.orgActor(w, r, access.CapOrgMembersManage)
	if !ok {
		return
	}
	var body struct {
		Name         string   `json:"name"`
		Capabilities []string `json:"capabilities"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	caps := make([]access.Capability, 0, len(body.Capabilities))
	allowed := map[string]struct{}{}
	for _, p := range aspecmod.PermissionCatalog() {
		if strings.HasPrefix(p.Key, "instance.") {
			continue
		}
		allowed[p.Key] = struct{}{}
	}
	for _, c := range body.Capabilities {
		if _, ok := allowed[c]; !ok {
			writeError(w, http.StatusBadRequest, "validation", "unknown or disallowed capability "+c)
			return
		}
		caps = append(caps, access.Capability(c))
	}
	role, err := s.Store.CreateOrgRole(r.Context(), org.ID, body.Name, caps)
	if err != nil {
		writeError(w, http.StatusConflict, "conflict", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, role)
}

func (s *Server) orgAssignments(w http.ResponseWriter, r *http.Request) {
	_, org, ok := s.orgActor(w, r, access.CapOrgView)
	if !ok {
		return
	}
	items, err := s.Store.ListRBACAssignments(r.Context(), org.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list assignments")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"assignments": items})
}

func (s *Server) orgMemberPatch(w http.ResponseWriter, r *http.Request) {
	_, org, ok := s.orgActor(w, r, access.CapOrgMembersManage)
	if !ok {
		return
	}
	var body struct {
		RoleID string `json:"role_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	if err := s.Store.SetMemberRole(r.Context(), org.ID, chi.URLParam(r, "userID"), body.RoleID); err != nil {
		writeError(w, http.StatusBadRequest, "validation", "could not change member role")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) orgMemberDelete(w http.ResponseWriter, r *http.Request) {
	actor, org, ok := s.orgActor(w, r, access.CapOrgMembersManage)
	if !ok {
		return
	}
	targetID := chi.URLParam(r, "userID")
	if targetID == actor.User.ID {
		writeError(w, http.StatusBadRequest, "validation", "you cannot remove yourself")
		return
	}
	if err := s.Store.RemoveMember(r.Context(), org.ID, targetID); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not remove member")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
