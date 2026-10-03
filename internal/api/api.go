package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"lorelink.dev/lorelink/internal/access"
	"lorelink.dev/lorelink/internal/aspecmod"
	"lorelink.dev/lorelink/internal/connector"
	"lorelink.dev/lorelink/internal/identity"
	"lorelink.dev/lorelink/internal/maintainer"
	"lorelink.dev/lorelink/internal/searchidx"
	"lorelink.dev/lorelink/internal/secrets"
	"lorelink.dev/lorelink/internal/store"
	"lorelink.dev/lorelink/internal/workspace"
)

const (
	sessionCookie  = "lorelink_session"
	sessionTTL     = 14 * 24 * time.Hour
	inviteTTL      = 7 * 24 * time.Hour
	minPasswordLen = 10
)

type Server struct {
	Store        *store.Store
	Log          *slog.Logger
	Public       string
	Cipher       *secrets.Cipher
	Registry     *connector.Registry
	Workspace    *workspace.Manager
	Maintainer   *maintainer.Service
	Index        *searchidx.Indexer
	DataDir      string
	APIKeyPepper []byte
	ready        bool

	setupMu sync.Mutex
	loginMu sync.Mutex
	buckets map[string]*rateBucket
}

type rateBucket struct {
	until time.Time
	n     int
}

func New(st *store.Store, log *slog.Logger, publicURL string) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{Store: st, Log: log, Public: publicURL, ready: true, buckets: map[string]*rateBucket{}}
}

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(s.securityHeaders)
	r.Use(s.recoverer)

	r.Get("/healthz", s.healthz)
	r.Get("/readyz", s.readyz)

	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/setup/status", s.setupStatus)
		r.With(s.limit("setup", 10, time.Hour)).Post("/setup", s.setup)

		r.With(s.limit("login", 20, 10*time.Minute)).Post("/auth/login", s.login)
		r.Get("/invitations/{token}", s.invitationGet)
		r.With(s.limit("invite-accept", 20, time.Hour)).Post("/invitations/{token}/accept", s.invitationAccept)

		r.Group(func(r chi.Router) {
			r.Use(s.requireSession)
			r.Use(s.csrf)
			r.Post("/auth/logout", s.logout)
			r.Get("/me", s.me)
			r.Get("/instance", s.instance)
			r.Get("/instance/users", s.instanceUsers)
			r.Get("/roles", s.roles)
			r.Get("/orgs", s.orgs)
			r.Post("/orgs", s.orgCreate)
			r.Get("/orgs/{orgID}", s.orgGet)
			r.Get("/orgs/{orgID}/members", s.orgMembers)
			r.Post("/orgs/{orgID}/invitations", s.orgInvite)
			r.Get("/orgs/{orgID}/projects", s.projects)
			r.Post("/orgs/{orgID}/projects", s.projectCreate)
			r.Get("/orgs/{orgID}/activity", s.orgActivity)
		})
		s.mountASPEC(r)
		s.mountPlatform(r)
	})
	return r
}

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.Ping(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "not_ready", "database is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) setupStatus(w http.ResponseWriter, r *http.Request) {
	done, err := s.Store.SetupCompleted(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not read setup status")
		return
	}
	if done {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"completed": false})
}

type setupBody struct {
	InstanceName     string `json:"instance_name"`
	PublicURL        string `json:"public_url"`
	AdminName        string `json:"admin_name"`
	AdminEmail       string `json:"admin_email"`
	AdminPassword    string `json:"admin_password"`
	Organisation     string `json:"organisation_name"`
	OrganisationSlug string `json:"organisation_slug"`
}

func (s *Server) setup(w http.ResponseWriter, r *http.Request) {
	s.setupMu.Lock()
	defer s.setupMu.Unlock()

	done, err := s.Store.SetupCompleted(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not read setup status")
		return
	}
	if done {
		http.NotFound(w, r)
		return
	}
	var body setupBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	body.InstanceName = strings.TrimSpace(body.InstanceName)
	body.PublicURL = strings.TrimSpace(body.PublicURL)
	body.AdminName = strings.TrimSpace(body.AdminName)
	body.AdminEmail = strings.TrimSpace(strings.ToLower(body.AdminEmail))
	body.Organisation = strings.TrimSpace(body.Organisation)
	body.OrganisationSlug = slugify(firstNonEmpty(strings.TrimSpace(body.OrganisationSlug), body.Organisation))
	if body.InstanceName == "" || body.AdminName == "" || !validEmail(body.AdminEmail) || len(body.AdminPassword) < minPasswordLen || body.Organisation == "" || body.OrganisationSlug == "" {
		writeError(w, http.StatusBadRequest, "validation", "instance name, admin name, email, password (10+), and organisation are required")
		return
	}
	hash, salt, err := identity.HashPassword(body.AdminPassword)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not hash password")
		return
	}
	public := firstNonEmpty(body.PublicURL, s.Public)
	err = s.Store.CreateSetup(r.Context(), store.Instance{
		Name:          body.InstanceName,
		PublicBaseURL: public,
	}, store.User{
		Email:        body.AdminEmail,
		Name:         body.AdminName,
		PasswordHash: hash,
		PasswordSalt: salt,
	}, store.Organisation{
		Name: body.Organisation,
		Slug: body.OrganisationSlug,
	}, "Org Admin")
	if err != nil {
		s.Log.Error("setup failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "could not complete setup")
		return
	}
	admin, err := s.Store.GetUserByEmail(r.Context(), body.AdminEmail)
	if err == nil {
		_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{
			ActorUserID: &admin.ID,
			Action:      "setup.complete",
			Target:      body.InstanceName,
			IP:          clientIP(r),
		})
	}
	writeJSON(w, http.StatusCreated, map[string]any{"completed": true})
}

type loginBody struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body loginBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if locked, until, lerr := s.Store.IsLocked(r.Context(), email); lerr == nil && locked {
		msg := "account is locked after too many failed sign-in attempts"
		if until != nil {
			msg += "; try again after " + until.UTC().Format(time.RFC3339)
		}
		writeError(w, http.StatusTooManyRequests, "locked", msg)
		return
	}
	user, err := s.Store.GetUserByEmail(r.Context(), email)
	if err != nil || !identity.VerifyPassword(body.Password, user.PasswordHash, user.PasswordSalt) || user.Status != "active" {
		if locked, until, ferr := s.Store.RecordLoginFailure(r.Context(), email, lockoutFails, lockoutFor); ferr == nil && locked {
			msg := "account is locked after too many failed sign-in attempts"
			if until != nil {
				msg += "; try again after " + until.UTC().Format(time.RFC3339)
			}
			writeError(w, http.StatusTooManyRequests, "locked", msg)
			return
		}
		_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{Action: "auth.login.failed", Target: email, IP: clientIP(r)})
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "email or password is incorrect")
		return
	}
	_ = s.Store.ClearLoginFailures(r.Context(), email)
	raw, err := randomToken(32)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not create session")
		return
	}
	if err := s.Store.CreateSession(r.Context(), store.Session{
		UserID:    user.ID,
		TokenHash: store.HashToken(raw),
		ExpiresAt: time.Now().Add(sessionTTL),
		UserAgent: r.UserAgent(),
		IP:        clientIP(r),
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not create session")
		return
	}
	_ = s.Store.TouchLogin(r.Context(), user.ID)
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &user.ID, Action: "auth.login", IP: clientIP(r)})
	http.SetCookie(w, sessionCookieValue(hex.EncodeToString(raw), r, sessionTTL))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if raw, err := sessionToken(r); err == nil {
		_ = s.Store.DeleteSession(r.Context(), store.HashToken(raw))
	}
	http.SetCookie(w, sessionCookieValue("", r, -time.Hour))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	orgs, err := s.Store.ListOrganisationsForUser(r.Context(), user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list organisations")
		return
	}
	inst, _ := s.Store.GetInstance(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"user":          publicUser(user),
		"organisations": orgs,
		"instance":      publicInstance(inst),
	})
}

func (s *Server) instance(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	if !access.Has(user.InstanceCapabilities, access.CapInstanceAdmin) {
		writeError(w, http.StatusForbidden, "forbidden", "instance administration requires instance.admin")
		return
	}
	inst, err := s.Store.GetInstance(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not load instance")
		return
	}
	writeJSON(w, http.StatusOK, publicInstance(inst))
}

func (s *Server) instanceUsers(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	if !access.Has(user.InstanceCapabilities, access.CapInstanceAdmin) && !access.Has(user.InstanceCapabilities, access.CapInstanceUsersManage) {
		writeError(w, http.StatusForbidden, "forbidden", "instance user list requires instance administration")
		return
	}
	users, err := s.Store.ListUserAccounts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list users")
		return
	}
	out := make([]map[string]any, 0, len(users))
	for i := range users {
		out = append(out, publicUser(&users[i]))
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

func (s *Server) roles(w http.ResponseWriter, r *http.Request) {
	roles, err := s.Store.ListSystemRoles(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list roles")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": roles})
}

func (s *Server) orgCreate(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	if !access.Has(user.InstanceCapabilities, access.CapInstanceAdmin) && !access.Has(user.InstanceCapabilities, access.CapOrgProjectsCreate) {
		writeError(w, http.StatusForbidden, "forbidden", "creating an organisation requires instance.admin")
		return
	}
	var body struct {
		Name string `json:"name"`
		Slug string `json:"slug"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	slug := slugify(firstNonEmpty(strings.TrimSpace(body.Slug), name))
	if name == "" || slug == "" {
		writeError(w, http.StatusBadRequest, "validation", "name is required")
		return
	}
	org, err := s.Store.CreateOrganisation(r.Context(), store.Organisation{Name: name, Slug: slug}, user.ID, "Org Admin")
	if err != nil {
		writeError(w, http.StatusConflict, "conflict", "could not create organisation")
		return
	}
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &user.ID, OrgID: &org.ID, Action: "org.create", Target: org.Slug, IP: clientIP(r)})
	writeJSON(w, http.StatusCreated, org)
}

func (s *Server) orgs(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	orgs, err := s.Store.ListOrganisationsForUser(r.Context(), user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list organisations")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"organisations": orgs})
}

func (s *Server) orgGet(w http.ResponseWriter, r *http.Request) {
	actor, org, ok := s.orgActor(w, r, access.CapOrgView)
	if !ok {
		return
	}
	_ = actor
	writeJSON(w, http.StatusOK, org)
}

func (s *Server) orgMembers(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.orgActor(w, r, access.CapOrgView); !ok {
		return
	}
	members, err := s.Store.ListMembers(r.Context(), chi.URLParam(r, "orgID"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list members")
		return
	}
	out := make([]map[string]any, 0, len(members))
	for _, m := range members {
		u := publicUser(&m.User)
		u["role"] = map[string]any{"id": m.Role.ID, "name": m.Role.Name, "capabilities": m.Role.Capabilities}
		out = append(out, u)
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": out})
}

type inviteBody struct {
	Email  string `json:"email"`
	RoleID string `json:"role_id"`
}

func (s *Server) orgInvite(w http.ResponseWriter, r *http.Request) {
	actor, org, ok := s.orgActor(w, r, access.CapOrgMembersManage)
	if !ok {
		return
	}
	var body inviteBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if !validEmail(email) {
		writeError(w, http.StatusBadRequest, "validation", "a valid email is required")
		return
	}
	role, err := s.Store.RoleByID(r.Context(), body.RoleID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "validation", "unknown role")
		return
	}
	raw, err := randomToken(24)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not create invitation")
		return
	}
	if err := s.Store.CreateInvitation(r.Context(), store.Invitation{
		OrgID:     org.ID,
		Email:     email,
		RoleID:    role.ID,
		TokenHash: store.HashToken(raw),
		ExpiresAt: time.Now().Add(inviteTTL),
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not create invitation")
		return
	}
	token := hex.EncodeToString(raw)
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{
		ActorUserID: &actor.User.ID,
		OrgID:       &org.ID,
		Action:      "org.invite",
		Target:      email,
		IP:          clientIP(r),
	})
	writeJSON(w, http.StatusCreated, map[string]any{
		"email": email,
		"role":  role.Name,
		"token": token,
	})
}

func (s *Server) invitationGet(w http.ResponseWriter, r *http.Request) {
	inv, err := s.lookupInvite(r)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "invitation not found")
		return
	}
	if inv.AcceptedAt != nil || time.Now().After(inv.ExpiresAt) {
		writeError(w, http.StatusGone, "expired", "invitation is no longer valid")
		return
	}
	org, err := s.Store.GetOrganisation(r.Context(), inv.OrgID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "organisation not found")
		return
	}
	role, _ := s.Store.RoleByID(r.Context(), inv.RoleID)
	writeJSON(w, http.StatusOK, map[string]any{
		"email":        inv.Email,
		"organisation": org,
		"role":         role,
	})
}

type acceptBody struct {
	Name     string `json:"name"`
	Password string `json:"password"`
}

func (s *Server) invitationAccept(w http.ResponseWriter, r *http.Request) {
	inv, err := s.lookupInvite(r)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "invitation not found")
		return
	}
	if inv.AcceptedAt != nil || time.Now().After(inv.ExpiresAt) {
		writeError(w, http.StatusGone, "expired", "invitation is no longer valid")
		return
	}
	var body acceptBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" || len(body.Password) < minPasswordLen {
		writeError(w, http.StatusBadRequest, "validation", "name and password (10+) are required")
		return
	}
	hash, salt, err := identity.HashPassword(body.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not hash password")
		return
	}
	if err := s.Store.AcceptInvitation(r.Context(), *inv, store.User{
		Email:        inv.Email,
		Name:         strings.TrimSpace(body.Name),
		PasswordHash: hash,
		PasswordSalt: salt,
	}); err != nil {
		writeError(w, http.StatusConflict, "conflict", "could not accept invitation")
		return
	}
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{Action: "org.invite.accept", Target: inv.Email, OrgID: &inv.OrgID, IP: clientIP(r)})
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (s *Server) projects(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.orgActor(w, r, access.CapOrgView); !ok {
		return
	}
	items, err := s.Store.ListProjects(r.Context(), chi.URLParam(r, "orgID"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list projects")
		return
	}
	if items == nil {
		items = []store.Project{}
	}
	out := make([]map[string]any, 0, len(items))
	for i := range items {
		binding, berr := s.Store.GetBinding(r.Context(), items[i].ID)
		if berr != nil && !errors.Is(berr, store.ErrNotFound) {
			writeError(w, http.StatusInternalServerError, "internal", "could not list project bindings")
			return
		}
		p := items[i]
		out = append(out, map[string]any{
			"id":             p.ID,
			"org_id":         p.OrgID,
			"name":           p.Name,
			"slug":           p.Slug,
			"description":    p.Description,
			"visibility":     p.Visibility,
			"docs_root":      p.DocsRoot,
			"default_branch": p.DefaultBranch,
			"publish_policy": p.PublishPolicy,
			"host":           p.Host,
			"base_path":      p.BasePath,
			"created_at":     p.CreatedAt,
			"binding":        publicBinding(binding),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": out})
}

type projectBody struct {
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Description string `json:"description"`
	Visibility  string `json:"visibility"`
}

func (s *Server) projectCreate(w http.ResponseWriter, r *http.Request) {
	actor, org, ok := s.orgActor(w, r, access.CapOrgProjectsCreate)
	if !ok {
		return
	}
	var body projectBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	slug := slugify(firstNonEmpty(strings.TrimSpace(body.Slug), name))
	vis := body.Visibility
	if vis == "" {
		vis = "private"
	}
	if name == "" || slug == "" || (vis != "public" && vis != "internal" && vis != "private") {
		writeError(w, http.StatusBadRequest, "validation", "name and a valid visibility are required")
		return
	}
	p, err := s.Store.CreateProject(r.Context(), store.Project{
		OrgID:       org.ID,
		Name:        name,
		Slug:        slug,
		Description: strings.TrimSpace(body.Description),
		Visibility:  vis,
	})
	if err != nil {
		writeError(w, http.StatusConflict, "conflict", "could not create project")
		return
	}
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{
		ActorUserID: &actor.User.ID,
		OrgID:       &org.ID,
		ProjectID:   &p.ID,
		Action:      "project.create",
		Target:      p.Slug,
		IP:          clientIP(r),
	})
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) orgActivity(w http.ResponseWriter, r *http.Request) {
	_, org, ok := s.orgActorSilent(r, access.CapOrgAuditView)
	if !ok {
		_, org, ok = s.orgActorSilent(r, access.CapAuditView)
	}
	if !ok {
		writeError(w, http.StatusForbidden, "forbidden", "missing capability to view activity")
		return
	}
	events, err := s.Store.ListAudit(r.Context(), org.ID, 50)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list activity")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

type orgActor struct {
	User       *store.User
	Membership *store.Membership
	Actor      access.Actor
}

func (s *Server) orgActor(w http.ResponseWriter, r *http.Request, cap access.Capability) (orgActor, *store.Organisation, bool) {
	user := userFrom(r.Context())
	orgID := chi.URLParam(r, "orgID")
	org, err := s.Store.GetOrganisation(r.Context(), orgID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "organisation not found")
		return orgActor{}, nil, false
	}
	mem, err := s.Store.Membership(r.Context(), orgID, user.ID)
	if err != nil && !access.Has(user.InstanceCapabilities, access.CapInstanceAdmin) {
		writeError(w, http.StatusForbidden, "forbidden", "not a member of this organisation")
		return orgActor{}, nil, false
	}
	actor := access.Actor{UserID: user.ID, InstanceCapabilities: user.InstanceCapabilities}
	if mem != nil {
		actor.OrganisationCaps = mem.Role.Capabilities
	}
	if !actor.Can(cap) {
		writeError(w, http.StatusForbidden, "forbidden", "missing capability "+string(cap))
		return orgActor{}, nil, false
	}
	return orgActor{User: user, Membership: mem, Actor: actor}, org, true
}

func (s *Server) orgActorSilent(r *http.Request, cap access.Capability) (orgActor, *store.Organisation, bool) {
	user := userFrom(r.Context())
	orgID := chi.URLParam(r, "orgID")
	org, err := s.Store.GetOrganisation(r.Context(), orgID)
	if err != nil {
		return orgActor{}, nil, false
	}
	mem, err := s.Store.Membership(r.Context(), orgID, user.ID)
	if err != nil && !access.Has(user.InstanceCapabilities, access.CapInstanceAdmin) {
		return orgActor{}, nil, false
	}
	actor := access.Actor{UserID: user.ID, InstanceCapabilities: user.InstanceCapabilities}
	if mem != nil {
		actor.OrganisationCaps = mem.Role.Capabilities
	}
	if !actor.Can(cap) {
		return orgActor{}, nil, false
	}
	return orgActor{User: user, Membership: mem, Actor: actor}, org, true
}

func (s *Server) lookupInvite(r *http.Request) (*store.Invitation, error) {
	raw, err := hex.DecodeString(chi.URLParam(r, "token"))
	if err != nil {
		return nil, err
	}
	return s.Store.InvitationByTokenHash(r.Context(), store.HashToken(raw))
}

type ctxKey int

const userKey ctxKey = 1

func userFrom(ctx context.Context) *store.User {
	u, _ := ctx.Value(userKey).(*store.User)
	return u
}

func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if raw, err := sessionToken(r); err == nil {
			user, err := s.Store.SessionUser(r.Context(), store.HashToken(raw))
			if err == nil && user.Status == "active" {
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
				return
			}
		}
		if key := rawAPIKey(r); key != "" && len(s.APIKeyPepper) > 0 {
			user, err := s.Store.UserByAPIKeyHash(r.Context(), aspecmod.HashKey(s.APIKeyPepper, key), clientIP(r))
			if err == nil {
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
				return
			}
		}
		if tok := bearerToken(r); len(tok) > 0 {
			user, err := s.Store.UserByAPIToken(r.Context(), store.HashToken(tok))
			if err == nil && user.Status == "active" {
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
				return
			}
		}
		writeError(w, http.StatusUnauthorized, "unauthenticated", "authentication required")
	})
}

func (s *Server) csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		host := r.Host
		if !strings.Contains(origin, host) {
			writeError(w, http.StatusForbidden, "csrf", "origin does not match host")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.Log.Error("panic", "err", rec)
				writeError(w, http.StatusInternalServerError, "internal", "unexpected error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) limit(name string, n int, d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := name + ":" + clientIP(r)
			s.loginMu.Lock()
			b := s.buckets[key]
			now := time.Now()
			if b == nil || now.After(b.until) {
				b = &rateBucket{until: now.Add(d)}
				s.buckets[key] = b
			}
			b.n++
			over := b.n > n
			s.loginMu.Unlock()
			if over {
				writeError(w, http.StatusTooManyRequests, "rate_limited", "too many attempts")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) projectActor(w http.ResponseWriter, r *http.Request, cap access.Capability) (orgActor, *store.Project, bool) {
	actor, org, ok := s.orgActor(w, r, access.CapOrgView)
	if !ok {
		return orgActor{}, nil, false
	}
	p, err := s.Store.GetProject(r.Context(), chi.URLParam(r, "projectID"))
	if err != nil || p.OrgID != org.ID {
		writeError(w, http.StatusNotFound, "not_found", "project not found")
		return orgActor{}, nil, false
	}
	if !actor.Actor.Can(cap) {
		writeError(w, http.StatusForbidden, "forbidden", "missing capability "+string(cap))
		return orgActor{}, nil, false
	}
	return actor, p, true
}

func publicBinding(b *store.ProjectBinding) any {
	if b == nil {
		return nil
	}
	return map[string]any{
		"connection_id":   b.ConnectionID,
		"repo_url":        b.RepoURL,
		"repo_full_name":  b.RepoFullName,
		"default_branch":  b.DefaultBranch,
		"docs_root":       b.DocsRoot,
		"generated_roots": b.GeneratedRoots,
		"last_synced_sha": b.LastSyncedSHA,
		"last_synced_at":  b.LastSyncedAt,
		"poll_fallback":   b.PollFallback,
		"status":          b.Status,
		"status_error":    b.StatusError,
		"webhook_id":      b.WebhookID,
	}
}

func (s *Server) readPublishedOrWorkspace(p *store.Project, orgSlug, version, rel string) ([]byte, error) {
	if s.DataDir != "" {
		pub := filepath.Join(s.DataDir, "published", orgSlug, p.Slug, version, filepath.FromSlash(rel))
		if b, err := os.ReadFile(pub); err == nil {
			return b, nil
		}
	}
	if s.Workspace == nil {
		return nil, errors.New("not found")
	}
	b, err := s.Store.GetBinding(context.Background(), p.ID)
	if err != nil {
		return nil, err
	}
	return s.Workspace.ReadOwned(p, b, rel)
}

func rawAPIKey(r *http.Request) string {
	if key := strings.TrimSpace(r.Header.Get("X-Api-Key")); key != "" {
		return key
	}
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(strings.ToLower(h), "bearer ") {
		return ""
	}
	tok := strings.TrimSpace(h[7:])
	if strings.HasPrefix(tok, aspecmod.DefaultKeyPrefix) {
		return tok
	}
	return ""
}

func bearerToken(r *http.Request) []byte {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(strings.ToLower(h), "bearer ") {
		return nil
	}
	raw, err := hex.DecodeString(strings.TrimSpace(h[7:]))
	if err != nil {
		return nil
	}
	return raw
}

func sessionToken(r *http.Request) ([]byte, error) {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return nil, errors.New("missing")
	}
	return hex.DecodeString(c.Value)
}

func sessionCookieValue(value string, r *http.Request, ttl time.Duration) *http.Cookie {
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	maxAge := int(ttl.Seconds())
	if ttl < 0 {
		maxAge = -1
	}
	return &http.Cookie{
		Name:     sessionCookie,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func publicUser(u *store.User) map[string]any {
	if u == nil {
		return nil
	}
	return map[string]any{
		"id":                    u.ID,
		"email":                 u.Email,
		"name":                  u.Name,
		"display_name":          firstNonEmpty(u.DisplayName, u.Name),
		"status":                u.Status,
		"instance_capabilities": u.InstanceCapabilities,
		"suspend_reason":        u.SuspendReason,
		"suspended_until":       u.SuspendedUntil,
		"last_login_at":         u.LastLoginAt,
		"created_at":            u.CreatedAt,
	}
}

func publicInstance(inst *store.Instance) map[string]any {
	if inst == nil {
		return nil
	}
	return map[string]any{
		"id":              inst.ID,
		"name":            inst.Name,
		"public_base_url": inst.PublicBaseURL,
		"portal_enabled":  inst.PortalEnabled,
		"setup_completed": inst.SetupCompletedAt != nil,
	}
}

func randomToken(n int) ([]byte, error) {
	b := make([]byte, n)
	_, err := rand.Read(b)
	return b, err
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Real-IP"); xff != "" {
		return xff
	}
	return strings.Split(r.RemoteAddr, ":")[0]
}

func validEmail(s string) bool {
	return strings.Count(s, "@") == 1 && len(s) > 3 && !strings.ContainsAny(s, " \t\n")
}

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevDash = false
			continue
		}
		if !prevDash {
			b.WriteByte('-')
			prevDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
