package api

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"lorelink.dev/lorelink/internal/access"
	"lorelink.dev/lorelink/internal/connector"
	"lorelink.dev/lorelink/internal/jobs"
	"lorelink.dev/lorelink/internal/loremark"
	"lorelink.dev/lorelink/internal/maintainer"
	"lorelink.dev/lorelink/internal/publish"
	"lorelink.dev/lorelink/internal/secrets"
	"lorelink.dev/lorelink/internal/store"
	"lorelink.dev/lorelink/internal/workspace"
)

func (s *Server) WithPlatform(cipher *secrets.Cipher, reg *connector.Registry, ws *workspace.Manager, dataDir string) *Server {
	s.Cipher = cipher
	s.Registry = reg
	s.Workspace = ws
	s.DataDir = dataDir
	return s
}

func (s *Server) mountPlatform(r chi.Router) {
	r.Post("/webhooks/{provider}/{connectionID}", s.webhook)
	r.Get("/public/resolve", s.publicResolve)
	r.Get("/public/{orgSlug}/{projectSlug}", s.publicSite)
	r.Get("/public/{orgSlug}/{projectSlug}/page", s.publicPage)
	r.Get("/public/{orgSlug}/{projectSlug}/search", s.publicSearch)

	r.Group(func(r chi.Router) {
		r.Use(s.requireSession)
		r.Use(s.csrf)
		r.Post("/auth/token", s.createToken)
		r.Patch("/instance", s.instancePatch)
		r.Get("/orgs/{orgID}/connections", s.connections)
		r.Post("/orgs/{orgID}/connections", s.connectionCreate)
		r.Get("/orgs/{orgID}/connections/{connID}/repos", s.connectionRepos)
		r.Delete("/orgs/{orgID}/connections/{connID}", s.connectionDelete)
		r.Get("/orgs/{orgID}/teams", s.teams)
		r.Post("/orgs/{orgID}/teams", s.teamCreate)
		r.Get("/orgs/{orgID}/teams/{teamID}/members", s.teamMembers)
		r.Post("/orgs/{orgID}/teams/{teamID}/members", s.teamAddMember)
		r.Get("/orgs/{orgID}/projects/{projectID}", s.projectGet)
		r.Patch("/orgs/{orgID}/projects/{projectID}", s.projectPatch)
		r.Post("/orgs/{orgID}/projects/{projectID}/bind", s.projectBind)
		r.Post("/orgs/{orgID}/projects/{projectID}/sync", s.projectSync)
		r.Get("/orgs/{orgID}/projects/{projectID}/jobs", s.projectJobs)
		r.Get("/orgs/{orgID}/projects/{projectID}/files", s.projectFiles)
		r.Get("/orgs/{orgID}/projects/{projectID}/file", s.projectFileGet)
		r.Put("/orgs/{orgID}/projects/{projectID}/file", s.projectFilePut)
		r.Delete("/orgs/{orgID}/projects/{projectID}/file", s.projectFileDelete)
		r.Post("/orgs/{orgID}/projects/{projectID}/lease", s.projectLease)
		r.Delete("/orgs/{orgID}/projects/{projectID}/lease", s.projectLeaseRelease)
		r.Post("/orgs/{orgID}/projects/{projectID}/commit", s.projectCommit)
		r.Get("/orgs/{orgID}/projects/{projectID}/versions", s.projectVersions)
		r.Post("/orgs/{orgID}/projects/{projectID}/versions", s.projectVersionCreate)
		r.Post("/orgs/{orgID}/projects/{projectID}/publish", s.projectPublish)
		r.Get("/orgs/{orgID}/projects/{projectID}/publish", s.projectPublishList)
		r.Get("/orgs/{orgID}/projects/{projectID}/publish/{runID}/download", s.projectPublishDownload)
		r.Get("/orgs/{orgID}/projects/{projectID}/search", s.projectSearch)
		r.Post("/orgs/{orgID}/projects/{projectID}/search/reindex", s.projectReindex)
		r.Get("/orgs/{orgID}/projects/{projectID}/maintainer/mappings", s.mappings)
		r.Post("/orgs/{orgID}/projects/{projectID}/maintainer/mappings", s.mappingCreate)
		r.Delete("/orgs/{orgID}/projects/{projectID}/maintainer/mappings/{mappingID}", s.mappingDelete)
		r.Post("/orgs/{orgID}/projects/{projectID}/maintainer/check", s.maintainCheck)
		r.Post("/orgs/{orgID}/projects/{projectID}/maintainer/sync", s.maintainSync)
		r.Post("/orgs/{orgID}/projects/{projectID}/maintainer/explain", s.maintainExplain)
		r.Get("/orgs/{orgID}/projects/{projectID}/redirects", s.redirects)
		r.Post("/orgs/{orgID}/projects/{projectID}/redirects", s.redirectCreate)
	})
}

func (s *Server) createToken(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	raw, err := randomToken(24)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not create token")
		return
	}
	tok, err := s.Store.CreateAPIToken(r.Context(), store.APIToken{
		UserID:    user.ID,
		Name:      "cli-" + time.Now().UTC().Format("20060102-150405"),
		TokenHash: store.HashToken(raw),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not store token")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": hex.EncodeToString(raw), "id": tok.ID, "name": tok.Name})
}

func (s *Server) instancePatch(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	if !access.Has(user.InstanceCapabilities, access.CapInstanceAdmin) && !access.Has(user.InstanceCapabilities, access.CapInstanceSettingsManage) {
		writeError(w, http.StatusForbidden, "forbidden", "instance settings require instance administration")
		return
	}
	var body struct {
		PortalEnabled *bool `json:"portal_enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	if body.PortalEnabled != nil {
		if err := s.Store.SetPortalEnabled(r.Context(), *body.PortalEnabled); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "could not update instance")
			return
		}
	}
	inst, err := s.Store.GetInstance(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not load instance")
		return
	}
	writeJSON(w, http.StatusOK, publicInstance(inst))
}

func (s *Server) connections(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.orgActor(w, r, access.CapOrgView); !ok {
		return
	}
	items, err := s.Store.ListConnections(r.Context(), chi.URLParam(r, "orgID"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list connections")
		return
	}
	out := make([]map[string]any, 0, len(items))
	for _, c := range items {
		out = append(out, store.PublicConnection(c))
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": out})
}

func (s *Server) connectionCreate(w http.ResponseWriter, r *http.Request) {
	actor, org, ok := s.orgActor(w, r, access.CapOrgConnectionsManage)
	if !ok {
		return
	}
	if s.Registry == nil || s.Workspace == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "git connectors are not configured")
		return
	}
	var body struct {
		Provider    string `json:"provider"`
		DisplayName string `json:"display_name"`
		BaseURL     string `json:"base_url"`
		AuthKind    string `json:"auth_kind"`
		Token       string `json:"token"`
		Username    string `json:"username"`
		Password    string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	body.Provider = strings.ToLower(strings.TrimSpace(body.Provider))
	body.DisplayName = strings.TrimSpace(body.DisplayName)
	if body.DisplayName == "" || body.Provider == "" {
		writeError(w, http.StatusBadRequest, "validation", "provider and display name are required")
		return
	}
	prov, err := s.Registry.Get(body.Provider)
	if err != nil {
		writeError(w, http.StatusBadRequest, "validation", "unsupported provider")
		return
	}
	if body.AuthKind == "" {
		body.AuthKind = "token"
	}
	id := ""
	conn := store.GitConnection{
		OrgID:       org.ID,
		Provider:    body.Provider,
		DisplayName: body.DisplayName,
		BaseURL:     strings.TrimSpace(body.BaseURL),
		AuthKind:    body.AuthKind,
		CreatedBy:   &actor.User.ID,
	}
	created, err := s.Store.CreateConnection(r.Context(), conn)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not create connection")
		return
	}
	id = created.ID
	secret, err := s.Workspace.EncryptSecret(id, connector.Secret{Token: body.Token, Username: body.Username, Password: body.Password})
	if err != nil {
		_ = s.Store.DeleteConnection(r.Context(), id)
		writeError(w, http.StatusInternalServerError, "internal", "could not encrypt secret")
		return
	}
	if _, err := s.Store.DB.ExecContext(r.Context(), `UPDATE git_connections SET secret_ciphertext = $2 WHERE id = $1`, id, secret); err != nil {
		_ = s.Store.DeleteConnection(r.Context(), id)
		writeError(w, http.StatusInternalServerError, "internal", "could not store secret")
		return
	}
	created.SecretCiphertext = secret
	live, err := s.Workspace.LiveConn(created)
	if err == nil {
		if testErr := prov.Test(r.Context(), live); testErr != nil {
			writeJSON(w, http.StatusCreated, map[string]any{"connection": store.PublicConnection(*created), "warning": testErr.Error()})
			return
		}
	}
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &actor.User.ID, OrgID: &org.ID, Action: "connection.create", Target: created.DisplayName, IP: clientIP(r)})
	writeJSON(w, http.StatusCreated, map[string]any{"connection": store.PublicConnection(*created)})
}

func (s *Server) connectionRepos(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.orgActor(w, r, access.CapOrgConnectionsManage); !ok {
		return
	}
	conn, err := s.Store.GetConnection(r.Context(), chi.URLParam(r, "connID"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "connection not found")
		return
	}
	prov, err := s.Registry.Get(conn.Provider)
	if err != nil {
		writeError(w, http.StatusBadRequest, "validation", "unsupported provider")
		return
	}
	live, err := s.Workspace.LiveConn(conn)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not decrypt connection")
		return
	}
	repos, err := prov.ListRepos(r.Context(), live)
	if err != nil {
		writeError(w, http.StatusBadGateway, "upstream", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"repos": repos})
}

func (s *Server) connectionDelete(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.orgActor(w, r, access.CapOrgConnectionsManage); !ok {
		return
	}
	if err := s.Store.DeleteConnection(r.Context(), chi.URLParam(r, "connID")); err != nil {
		writeError(w, http.StatusConflict, "conflict", "could not delete connection")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) teams(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.orgActor(w, r, access.CapOrgView); !ok {
		return
	}
	items, err := s.Store.ListTeams(r.Context(), chi.URLParam(r, "orgID"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list teams")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": items})
}

func (s *Server) teamCreate(w http.ResponseWriter, r *http.Request) {
	_, org, ok := s.orgActor(w, r, access.CapOrgTeamsManage)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusBadRequest, "validation", "name is required")
		return
	}
	t, err := s.Store.CreateTeam(r.Context(), store.Team{OrgID: org.ID, Name: strings.TrimSpace(body.Name)})
	if err != nil {
		writeError(w, http.StatusConflict, "conflict", "could not create team")
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

func (s *Server) teamMembers(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.orgActor(w, r, access.CapOrgView); !ok {
		return
	}
	items, err := s.Store.ListTeamMembers(r.Context(), chi.URLParam(r, "teamID"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list team members")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": items})
}

func (s *Server) teamAddMember(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.orgActor(w, r, access.CapOrgTeamsManage); !ok {
		return
	}
	var body struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.UserID == "" {
		writeError(w, http.StatusBadRequest, "validation", "user_id is required")
		return
	}
	if err := s.Store.AddTeamMember(r.Context(), chi.URLParam(r, "teamID"), body.UserID); err != nil {
		writeError(w, http.StatusConflict, "conflict", "could not add member")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (s *Server) projectGet(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsView)
	if !ok {
		return
	}
	binding, err := s.Store.GetBinding(r.Context(), p.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusInternalServerError, "internal", "could not load binding")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"project": p, "binding": publicBinding(binding)})
}

func (s *Server) projectPatch(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsSettingsManage)
	if !ok {
		return
	}
	var body struct {
		Name, Description, Visibility, DocsRoot, DefaultBranch, PublishPolicy, Host, BasePath string
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	if body.Name != "" {
		p.Name = body.Name
	}
	if body.Description != "" {
		p.Description = body.Description
	}
	if body.Visibility != "" {
		p.Visibility = body.Visibility
	}
	if body.DocsRoot != "" {
		p.DocsRoot = body.DocsRoot
	}
	if body.DefaultBranch != "" {
		p.DefaultBranch = body.DefaultBranch
	}
	if body.PublishPolicy != "" {
		p.PublishPolicy = body.PublishPolicy
	}
	p.Host = body.Host
	p.BasePath = body.BasePath
	if err := s.Store.UpdateProject(r.Context(), *p); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not update project")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) projectBind(w http.ResponseWriter, r *http.Request) {
	actor, p, ok := s.projectActor(w, r, access.CapProjectConnectionsManage)
	if !ok {
		return
	}
	var body struct {
		ConnectionID   string   `json:"connection_id"`
		RepoURL        string   `json:"repo_url"`
		RepoFullName   string   `json:"repo_full_name"`
		DefaultBranch  string   `json:"default_branch"`
		DocsRoot       string   `json:"docs_root"`
		GeneratedRoots []string `json:"generated_roots"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	if body.ConnectionID == "" || (body.RepoURL == "" && body.RepoFullName == "") {
		writeError(w, http.StatusBadRequest, "validation", "connection and repository are required")
		return
	}
	conn, err := s.Store.GetConnection(r.Context(), body.ConnectionID)
	if err != nil || conn.OrgID != p.OrgID {
		writeError(w, http.StatusBadRequest, "validation", "unknown connection")
		return
	}
	secretRaw, err := randomToken(24)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not create webhook secret")
		return
	}
	hookSecret := []byte(hex.EncodeToString(secretRaw))
	b := store.ProjectBinding{
		ProjectID:      p.ID,
		ConnectionID:   conn.ID,
		RepoURL:        firstNonEmpty(body.RepoURL, body.RepoFullName),
		RepoFullName:   body.RepoFullName,
		DefaultBranch:  firstNonEmpty(body.DefaultBranch, p.DefaultBranch),
		DocsRoot:       firstNonEmpty(body.DocsRoot, p.DocsRoot),
		GeneratedRoots: body.GeneratedRoots,
		WebhookSecret:  hookSecret,
		Status:         "binding",
		WorkspaceRelpath: filepath.Join("workspaces", p.ID),
	}
	poll := true
	hookID := ""
	if s.Registry != nil && s.Workspace != nil {
		if prov, err := s.Registry.Get(conn.Provider); err == nil {
			live, liveErr := s.Workspace.LiveConn(conn)
			if liveErr == nil {
				callback := strings.TrimRight(s.Public, "/") + "/api/v1/webhooks/" + conn.Provider + "/" + conn.ID
				res, regErr := prov.RegisterWebhook(r.Context(), live, firstNonEmpty(body.RepoFullName, body.RepoURL), callback, string(hookSecret))
				if regErr != nil || res.PollFallback {
					poll = true
				} else {
					poll = false
					hookID = res.ID
				}
			}
		}
	}
	b.PollFallback = poll
	b.WebhookID = hookID
	if err := s.Store.UpsertBinding(r.Context(), b); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not bind project")
		return
	}
	_, _ = s.Store.EnqueueJob(r.Context(), store.Job{OrgID: &p.OrgID, ProjectID: &p.ID, Kind: jobs.KindSync})
	_ = s.Store.WriteAudit(r.Context(), store.AuditEvent{ActorUserID: &actor.User.ID, OrgID: &p.OrgID, ProjectID: &p.ID, Action: "project.bind", Target: b.RepoURL, IP: clientIP(r)})
	writeJSON(w, http.StatusOK, map[string]any{"binding": publicBinding(&b), "poll_fallback": poll})
}

func (s *Server) projectSync(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsEdit)
	if !ok {
		return
	}
	job, err := s.Store.EnqueueJob(r.Context(), store.Job{OrgID: &p.OrgID, ProjectID: &p.ID, Kind: jobs.KindSync})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not enqueue sync")
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) projectJobs(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapJobsView)
	if !ok {
		return
	}
	items, err := s.Store.ListJobs(r.Context(), p.ID, 40)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list jobs")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": items})
}

func (s *Server) projectFiles(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsView)
	if !ok {
		return
	}
	b, err := s.Store.GetBinding(r.Context(), p.ID)
	if err != nil {
		writeError(w, http.StatusConflict, "not_bound", "project is not bound to a repository")
		return
	}
	tree, err := s.Workspace.Tree(p, b)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": tree})
}

func (s *Server) projectFileGet(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsView)
	if !ok {
		return
	}
	b, err := s.Store.GetBinding(r.Context(), p.ID)
	if err != nil {
		writeError(w, http.StatusConflict, "not_bound", "project is not bound to a repository")
		return
	}
	rel := strings.TrimSpace(r.URL.Query().Get("path"))
	raw, err := s.Workspace.ReadOwned(p, b, rel)
	if err != nil {
		writeError(w, http.StatusBadRequest, "path", err.Error())
		return
	}
	doc := loremark.Parse(string(raw))
	writeJSON(w, http.StatusOK, map[string]any{"path": rel, "content": string(raw), "doc": doc})
}

func (s *Server) projectFilePut(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsEdit)
	if !ok {
		return
	}
	b, err := s.Store.GetBinding(r.Context(), p.ID)
	if err != nil {
		writeError(w, http.StatusConflict, "not_bound", "project is not bound to a repository")
		return
	}
	var body struct {
		Path    string           `json:"path"`
		Content string           `json:"content"`
		Blocks  []loremark.Block `json:"blocks"`
		Lease   string           `json:"lease"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	if body.Lease != "" {
		lease, err := s.Store.LeaseByToken(r.Context(), body.Lease)
		if err != nil || lease.ProjectID != p.ID || lease.Path != body.Path {
			writeError(w, http.StatusConflict, "lease", "edit lease is missing or expired")
			return
		}
	}
	content := body.Content
	if len(body.Blocks) > 0 {
		content = loremark.Serialize(body.Blocks)
	}
	if err := s.Workspace.WriteOwned(p, b, body.Path, []byte(content)); err != nil {
		writeError(w, http.StatusBadRequest, "path", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "doc": loremark.Parse(content)})
}

func (s *Server) projectFileDelete(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsDelete)
	if !ok {
		return
	}
	b, err := s.Store.GetBinding(r.Context(), p.ID)
	if err != nil {
		writeError(w, http.StatusConflict, "not_bound", "project is not bound to a repository")
		return
	}
	if err := s.Workspace.DeleteOwned(p, b, r.URL.Query().Get("path")); err != nil {
		writeError(w, http.StatusBadRequest, "path", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) projectLease(w http.ResponseWriter, r *http.Request) {
	actor, p, ok := s.projectActor(w, r, access.CapDocsEdit)
	if !ok {
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Path == "" {
		writeError(w, http.StatusBadRequest, "validation", "path is required")
		return
	}
	raw, err := randomToken(16)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not create lease")
		return
	}
	token := hex.EncodeToString(raw)
	lease, err := s.Store.AcquireLease(r.Context(), store.EditLease{
		ProjectID: p.ID,
		Path:      body.Path,
		UserID:    actor.User.ID,
		Token:     token,
		ExpiresAt: time.Now().Add(15 * time.Minute),
	})
	if err != nil {
		writeError(w, http.StatusConflict, "lease", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, lease)
}

func (s *Server) projectLeaseRelease(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.projectActor(w, r, access.CapDocsEdit); !ok {
		return
	}
	_ = s.Store.ReleaseLease(r.Context(), r.URL.Query().Get("token"))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) projectCommit(w http.ResponseWriter, r *http.Request) {
	actor, p, ok := s.projectActor(w, r, access.CapDocsEdit)
	if !ok {
		return
	}
	b, err := s.Store.GetBinding(r.Context(), p.ID)
	if err != nil {
		writeError(w, http.StatusConflict, "not_bound", "project is not bound to a repository")
		return
	}
	var body struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	msg := strings.TrimSpace(body.Message)
	if msg == "" {
		msg = "docs: update from LoreLink"
	}
	sha, err := s.Workspace.CommitAndPush(r.Context(), p, b, msg, actor.User.Name, actor.User.Email)
	if err != nil {
		writeError(w, http.StatusBadGateway, "git", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sha": sha})
}

func (s *Server) projectVersions(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsView)
	if !ok {
		return
	}
	items, err := s.Store.ListVersions(r.Context(), p.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list versions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": items})
}

func (s *Server) projectVersionCreate(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsVersionsManage)
	if !ok {
		return
	}
	var body struct {
		Name, Alias, GitRef string
		Immutable           bool
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusBadRequest, "validation", "name is required")
		return
	}
	v, err := s.Store.CreateVersion(r.Context(), store.DocVersion{
		ProjectID: p.ID,
		Name:      strings.TrimSpace(body.Name),
		Alias:     body.Alias,
		GitRef:    firstNonEmpty(body.GitRef, p.DefaultBranch),
		Immutable: body.Immutable,
	})
	if err != nil {
		writeError(w, http.StatusConflict, "conflict", "could not create version")
		return
	}
	writeJSON(w, http.StatusCreated, v)
}

func (s *Server) projectPublish(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsPublish)
	if !ok {
		return
	}
	var body struct {
		Target  string `json:"target"`
		Version string `json:"version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	if body.Target == "" {
		body.Target = string(publish.Hosted)
	}
	run, err := s.Store.CreatePublishRun(r.Context(), store.PublishRun{
		ProjectID:   p.ID,
		Target:      body.Target,
		VersionName: firstNonEmpty(body.Version, "latest"),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not create publish run")
		return
	}
	payload, _ := json.Marshal(map[string]string{"run_id": run.ID})
	_, _ = s.Store.EnqueueJob(r.Context(), store.Job{OrgID: &p.OrgID, ProjectID: &p.ID, Kind: jobs.KindPublish, PayloadJSON: payload})
	writeJSON(w, http.StatusAccepted, run)
}

func (s *Server) projectPublishList(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsView)
	if !ok {
		return
	}
	items, err := s.Store.ListPublishRuns(r.Context(), p.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list publish runs")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": items})
}

func (s *Server) projectPublishDownload(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsView)
	if !ok {
		return
	}
	run, err := s.Store.GetPublishRun(r.Context(), chi.URLParam(r, "runID"))
	if err != nil || run.ProjectID != p.ID {
		writeError(w, http.StatusNotFound, "not_found", "publish run not found")
		return
	}
	if run.ArtifactPath == "" {
		writeError(w, http.StatusConflict, "not_ready", "artifact is not ready")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+p.Slug+`.zip"`)
	http.ServeFile(w, r, run.ArtifactPath)
}

func (s *Server) projectSearch(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsView)
	if !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{}})
		return
	}
	items, err := s.Store.SearchDocs(r.Context(), p.ID, r.URL.Query().Get("version"), q, 20)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "search failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": items})
}

func (s *Server) projectReindex(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsSearchReindex)
	if !ok {
		return
	}
	job, err := s.Store.EnqueueJob(r.Context(), store.Job{OrgID: &p.OrgID, ProjectID: &p.ID, Kind: jobs.KindReindex})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not enqueue reindex")
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) mappings(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsView)
	if !ok {
		return
	}
	items, err := s.Store.ListMappings(r.Context(), p.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list mappings")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mappings": items})
}

func (s *Server) mappingCreate(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsGeneratedManage)
	if !ok {
		return
	}
	var body store.MaintainerMapping
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body")
		return
	}
	body.ProjectID = p.ID
	if body.SourceMatch == "" || body.Extractor == "" || body.Output == "" {
		writeError(w, http.StatusBadRequest, "validation", "source_match, extractor, and output are required")
		return
	}
	m, err := s.Store.CreateMapping(r.Context(), body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not create mapping")
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (s *Server) mappingDelete(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.projectActor(w, r, access.CapDocsGeneratedManage); !ok {
		return
	}
	if err := s.Store.DeleteMapping(r.Context(), chi.URLParam(r, "mappingID")); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not delete mapping")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) maintainCheck(w http.ResponseWriter, r *http.Request) {
	s.maintainAction(w, r, "check")
}

func (s *Server) maintainSync(w http.ResponseWriter, r *http.Request) {
	s.maintainAction(w, r, "sync")
}

func (s *Server) maintainExplain(w http.ResponseWriter, r *http.Request) {
	s.maintainAction(w, r, "explain")
}

func (s *Server) maintainAction(w http.ResponseWriter, r *http.Request, action string) {
	_, p, ok := s.projectActor(w, r, access.CapDocsGeneratedManage)
	if !ok {
		return
	}
	if s.Maintainer == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "maintainer is not configured")
		return
	}
	var (
		rep maintainer.Report
		err error
	)
	switch action {
	case "sync":
		rep, err = s.Maintainer.Sync(r.Context(), p.ID)
	case "explain":
		rep, err = s.Maintainer.Explain(r.Context(), p.ID)
	default:
		rep, err = s.Maintainer.Check(r.Context(), p.ID)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (s *Server) redirects(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsView)
	if !ok {
		return
	}
	items, err := s.Store.ListRedirects(r.Context(), p.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not list redirects")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"redirects": items})
}

func (s *Server) redirectCreate(w http.ResponseWriter, r *http.Request) {
	_, p, ok := s.projectActor(w, r, access.CapDocsSettingsManage)
	if !ok {
		return
	}
	var body store.Redirect
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.FromPath == "" || body.ToPath == "" {
		writeError(w, http.StatusBadRequest, "validation", "from_path and to_path are required")
		return
	}
	body.ProjectID = p.ID
	if err := s.Store.UpsertRedirect(r.Context(), body); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not save redirect")
		return
	}
	writeJSON(w, http.StatusCreated, body)
}

func (s *Server) webhook(w http.ResponseWriter, r *http.Request) {
	if s.Registry == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "git connectors are not configured")
		return
	}
	provider := chi.URLParam(r, "provider")
	connID := chi.URLParam(r, "connectionID")
	conn, err := s.Store.GetConnection(r.Context(), connID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "connection not found")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "could not read webhook")
		return
	}
	prov, err := s.Registry.Get(provider)
	if err != nil {
		writeError(w, http.StatusBadRequest, "validation", "unsupported provider")
		return
	}
	bindings, err := s.Store.ListBindingsForConnection(r.Context(), conn.ID)
	if err != nil || len(bindings) == 0 {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
		return
	}
	event, err := prov.ParsePush(r, body, bindings[0].WebhookSecret)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_signature", "webhook rejected")
		return
	}
	sum := store.HashToken(body)
	delivery := firstNonEmpty(r.Header.Get("X-GitHub-Delivery"), r.Header.Get("X-CodeHold-Delivery"), r.Header.Get("X-Gitea-Delivery"))
	ok, err := s.Store.RecordWebhook(r.Context(), store.WebhookEvent{
		ConnectionID: &conn.ID,
		Provider:     provider,
		DeliveryID:   delivery,
		EventType:    firstNonEmpty(r.Header.Get("X-GitHub-Event"), "push"),
		PayloadHash:  sum,
	})
	if err != nil || !ok {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	for i := range bindings {
		if event != nil && event.Repo.FullName != "" && bindings[i].RepoFullName != "" && !strings.EqualFold(event.Repo.FullName, bindings[i].RepoFullName) {
			continue
		}
		_, _ = s.Store.EnqueueJob(r.Context(), store.Job{OrgID: &conn.OrgID, ProjectID: &bindings[i].ProjectID, Kind: jobs.KindSync})
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

func (s *Server) publicResolve(w http.ResponseWriter, r *http.Request) {
	host := strings.ToLower(strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("host"), r.Host)))
	if i := strings.Index(host, ":"); i > 0 {
		host = host[:i]
	}
	p, err := s.Store.GetProjectByHost(r.Context(), host)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "no project is bound to this host")
		return
	}
	org, err := s.Store.GetOrganisation(r.Context(), p.OrgID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "organisation not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"org":     org.Slug,
		"project": p.Slug,
		"host":    p.Host,
		"base_path": p.BasePath,
	})
}

func (s *Server) publicSite(w http.ResponseWriter, r *http.Request) {
	p, org, ok := s.publicProject(w, r)
	if !ok {
		return
	}
	version := firstNonEmpty(r.URL.Query().Get("version"), "latest")
	nav, title := s.siteNav(r, p, org.Slug, version)
	versions, _ := s.Store.ListVersions(r.Context(), p.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"project":  map[string]any{"name": p.Name, "slug": p.Slug, "org": org.Slug},
		"title":    title,
		"nav":      nav,
		"versions": versions,
		"version":  version,
	})
}

func (s *Server) publicPage(w http.ResponseWriter, r *http.Request) {
	p, org, ok := s.publicProject(w, r)
	if !ok {
		return
	}
	version := firstNonEmpty(r.URL.Query().Get("version"), "latest")
	rel := strings.TrimSpace(r.URL.Query().Get("path"))
	if rel == "" {
		rel = filepath.ToSlash(filepath.Join(firstNonEmpty(p.DocsRoot, "docs"), "index.md"))
	}
	if reds, err := s.Store.ListRedirects(r.Context(), p.ID); err == nil {
		for _, red := range reds {
			if red.FromPath == rel || red.FromPath == strings.TrimPrefix(rel, p.DocsRoot+"/") {
				rel = red.ToPath
				break
			}
		}
	}
	raw, err := s.readPublishedOrWorkspace(p, org.Slug, version, rel)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "page not found")
		return
	}
	doc := loremark.Parse(string(raw))
	writeJSON(w, http.StatusOK, map[string]any{"path": rel, "doc": doc})
}

func (s *Server) publicSearch(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.publicProject(w, r)
	if !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{}})
		return
	}
	items, err := s.Store.SearchDocs(r.Context(), p.ID, firstNonEmpty(r.URL.Query().Get("version"), "latest"), q, 20)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "search failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": items})
}

func (s *Server) publicProject(w http.ResponseWriter, r *http.Request) (*store.Project, *store.Organisation, bool) {
	org, err := s.Store.GetOrganisationBySlug(r.Context(), chi.URLParam(r, "orgSlug"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "site not found")
		return nil, nil, false
	}
	p, err := s.Store.GetProjectBySlug(r.Context(), org.ID, chi.URLParam(r, "projectSlug"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "site not found")
		return nil, nil, false
	}
	if p.Visibility == "public" {
		return p, org, true
	}
	user := userFrom(r.Context())
	if user == nil {
		raw, err := sessionToken(r)
		if err == nil {
			user, _ = s.Store.SessionUser(r.Context(), store.HashToken(raw))
		}
		if user == nil {
			if tok := bearerToken(r); len(tok) > 0 {
				user, _ = s.Store.UserByAPIToken(r.Context(), store.HashToken(tok))
			}
		}
	}
	if user == nil {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "this documentation is not public")
		return nil, nil, false
	}
	if access.Has(user.InstanceCapabilities, access.CapInstanceAdmin) {
		return p, org, true
	}
	if _, err := s.Store.Membership(r.Context(), org.ID, user.ID); err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "you do not have access to this documentation")
		return nil, nil, false
	}
	return p, org, true
}

func (s *Server) siteNav(r *http.Request, p *store.Project, orgSlug, version string) ([]loremark.NavItem, string) {
	title := p.Name
	var paths []string
	if s.Workspace != nil {
		if b, err := s.Store.GetBinding(r.Context(), p.ID); err == nil {
			if tree, err := s.Workspace.Tree(p, b); err == nil {
				for _, e := range tree {
					if !e.Dir {
						paths = append(paths, e.Path)
					}
				}
			}
		}
	}
	pub := filepath.Join(s.DataDir, "published", orgSlug, p.Slug, version)
	if entries, err := os.ReadDir(pub); err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
				paths = append(paths, e.Name())
			}
		}
	}
	return loremark.NavFromTree(paths, firstNonEmpty(p.DocsRoot, "docs")), title
}
