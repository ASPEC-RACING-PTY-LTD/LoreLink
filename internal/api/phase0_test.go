package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"lorelink.dev/lorelink/internal/api"
	"lorelink.dev/lorelink/internal/store"
)

func testStore(t *testing.T) *store.Store {
	t.Helper()
	url := os.Getenv("LORELINK_TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("LORELINK_DATABASE_URL")
	}
	if url == "" {
		t.Skip("LORELINK_TEST_DATABASE_URL or LORELINK_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	st, err := store.Open(ctx, url)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	if err := store.Migrate(ctx, st.DB); err != nil {
		st.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func reset(t *testing.T, st *store.Store) {
	t.Helper()
	_, err := st.DB.Exec(`
		DELETE FROM audit_events;
		DELETE FROM projects;
		DELETE FROM invitations;
		DELETE FROM team_memberships;
		DELETE FROM teams;
		DELETE FROM org_memberships;
		DELETE FROM sessions;
		DELETE FROM users;
		DELETE FROM instances;
		DELETE FROM organisations;
		DELETE FROM roles WHERE org_id IS NOT NULL;
		INSERT INTO roles (id, org_id, name, capabilities)
		SELECT id, org_id, name, capabilities FROM (VALUES
			('00000000-0000-4000-8000-000000000001'::uuid, NULL::uuid, 'Viewer', ARRAY['org.view', 'docs.view', 'audit.view']),
			('00000000-0000-4000-8000-000000000002'::uuid, NULL::uuid, 'Writer', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage']),
			('00000000-0000-4000-8000-000000000003'::uuid, NULL::uuid, 'Editor', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage', 'docs.delete']),
			('00000000-0000-4000-8000-000000000004'::uuid, NULL::uuid, 'Publisher', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage', 'docs.delete', 'docs.publish', 'docs.versions.manage']),
			('00000000-0000-4000-8000-000000000005'::uuid, NULL::uuid, 'Maintainer', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage', 'docs.delete', 'docs.publish', 'docs.versions.manage', 'docs.generated.manage', 'jobs.view', 'docs.search.reindex']),
			('00000000-0000-4000-8000-000000000006'::uuid, NULL::uuid, 'Project Admin', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage', 'docs.delete', 'docs.publish', 'docs.versions.manage', 'docs.generated.manage', 'jobs.view', 'docs.search.reindex', 'docs.settings.manage', 'docs.members.manage', 'project.connections.manage']),
			('00000000-0000-4000-8000-000000000007'::uuid, NULL::uuid, 'Org Admin', ARRAY['org.view', 'docs.view', 'audit.view', 'docs.edit', 'docs.create', 'docs.assets.manage', 'docs.delete', 'docs.publish', 'docs.versions.manage', 'docs.generated.manage', 'jobs.view', 'docs.search.reindex', 'docs.settings.manage', 'docs.members.manage', 'project.connections.manage', 'org.settings.manage', 'org.members.manage', 'org.teams.manage', 'org.projects.create', 'org.connections.manage', 'org.audit.view'])
		) AS v(id, org_id, name, capabilities)
		WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = v.id)`)
	if err != nil {
		t.Fatal(err)
	}
}

func TestPhase0SetupAuthRBAC(t *testing.T) {
	st := testStore(t)
	reset(t, st)
	srv := httptest.NewServer(api.New(st, nil, "http://example.test").Handler())
	t.Cleanup(srv.Close)

	// Unauthenticated API is denied.
	res, err := http.Get(srv.URL + "/api/v1/me")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated me: %d", res.StatusCode)
	}

	setup := map[string]string{
		"instance_name":       "LoreLink Dev",
		"public_url":          srv.URL,
		"admin_name":          "Ada Admin",
		"admin_email":         "ada@example.test",
		"admin_password":      "super-secret-password",
		"organisation_name":   "ASPEC",
		"organisation_slug":   "aspec",
	}
	status, body := postJSON(t, srv.URL+"/api/v1/setup", setup, nil)
	if status != http.StatusCreated {
		t.Fatalf("setup: %d %s", status, body)
	}

	// Setup route then 404s.
	status, _ = getJSON(t, srv.URL+"/api/v1/setup/status", nil)
	if status != http.StatusNotFound {
		t.Fatalf("setup status after complete: %d", status)
	}
	status, _ = postJSON(t, srv.URL+"/api/v1/setup", setup, nil)
	if status != http.StatusNotFound {
		t.Fatalf("setup post after complete: %d", status)
	}

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	status, _ = postJSONClient(t, client, srv.URL+"/api/v1/auth/login", map[string]string{
		"email":    "ada@example.test",
		"password": "super-secret-password",
	})
	if status != http.StatusOK {
		t.Fatalf("admin login: %d", status)
	}

	status, me := getJSONClient(t, client, srv.URL+"/api/v1/me")
	if status != http.StatusOK {
		t.Fatalf("me: %d %s", status, me)
	}
	var meResp struct {
		Organisations []struct {
			ID string `json:"id"`
		} `json:"organisations"`
	}
	if err := json.Unmarshal([]byte(me), &meResp); err != nil {
		t.Fatal(err)
	}
	if len(meResp.Organisations) != 1 {
		t.Fatalf("orgs=%d", len(meResp.Organisations))
	}
	orgID := meResp.Organisations[0].ID

	status, inst := getJSONClient(t, client, srv.URL+"/api/v1/instance")
	if status != http.StatusOK {
		t.Fatalf("admin instance: %d %s", status, inst)
	}

	status, rolesBody := getJSONClient(t, client, srv.URL+"/api/v1/roles")
	if status != http.StatusOK {
		t.Fatalf("roles: %d", status)
	}
	var rolesResp struct {
		Roles []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"roles"`
	}
	if err := json.Unmarshal([]byte(rolesBody), &rolesResp); err != nil {
		t.Fatal(err)
	}
	var writerID string
	for _, r := range rolesResp.Roles {
		if r.Name == "Writer" {
			writerID = r.ID
		}
	}
	if writerID == "" {
		t.Fatal("missing Writer role")
	}

	status, invBody := postJSONClient(t, client, srv.URL+"/api/v1/orgs/"+orgID+"/invitations", map[string]string{
		"email":   "wes@example.test",
		"role_id": writerID,
	})
	if status != http.StatusCreated {
		t.Fatalf("invite: %d %s", status, invBody)
	}
	var inv struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal([]byte(invBody), &inv); err != nil {
		t.Fatal(err)
	}

	status, _ = postJSON(t, srv.URL+"/api/v1/invitations/"+inv.Token+"/accept", map[string]string{
		"name":     "Wes Writer",
		"password": "writer-secret-password",
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("accept invite: %d", status)
	}

	writerJar, _ := cookiejar.New(nil)
	writerClient := &http.Client{Jar: writerJar}
	status, _ = postJSONClient(t, writerClient, srv.URL+"/api/v1/auth/login", map[string]string{
		"email":    "wes@example.test",
		"password": "writer-secret-password",
	})
	if status != http.StatusOK {
		t.Fatalf("writer login: %d", status)
	}
	status, denied := getJSONClient(t, writerClient, srv.URL+"/api/v1/instance")
	if status != http.StatusForbidden {
		t.Fatalf("writer instance access: %d %s", status, denied)
	}

	status, _ = postJSONClient(t, client, srv.URL+"/api/v1/orgs/"+orgID+"/projects", map[string]string{
		"name":        "CodeHold Docs",
		"slug":        "codehold",
		"description": "Documentation control plane for CodeHold",
		"visibility":  "internal",
	})
	if status != http.StatusCreated {
		t.Fatalf("create project: %d", status)
	}
}

func postJSON(t *testing.T, url string, payload any, cookies []*http.Cookie) (int, string) {
	t.Helper()
	client := &http.Client{}
	return postJSONClient(t, client, url, payload)
}

func postJSONClient(t *testing.T, client *http.Client, url string, payload any) (int, string) {
	t.Helper()
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func getJSON(t *testing.T, url string, _ []*http.Cookie) (int, string) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func getJSONClient(t *testing.T, client *http.Client, url string) (int, string) {
	t.Helper()
	res, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(b))
}
