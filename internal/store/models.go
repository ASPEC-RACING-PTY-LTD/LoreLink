package store

import (
	"time"

	"lorelink.dev/lorelink/internal/access"
)

type Instance struct {
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	PublicBaseURL    string     `json:"public_base_url"`
	PortalEnabled    bool       `json:"portal_enabled"`
	SetupCompletedAt *time.Time `json:"setup_completed_at,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
}

type User struct {
	ID                   string              `json:"id"`
	Email                string              `json:"email"`
	Name                 string              `json:"name"`
	DisplayName          string              `json:"display_name,omitempty"`
	PasswordHash         []byte              `json:"-"`
	PasswordSalt         []byte              `json:"-"`
	Status               string              `json:"status"`
	InstanceCapabilities []access.Capability `json:"instance_capabilities"`
	SuspendReason        string              `json:"suspend_reason,omitempty"`
	SuspendedUntil       *time.Time          `json:"suspended_until,omitempty"`
	LastLoginAt          *time.Time          `json:"last_login_at,omitempty"`
	CreatedAt            time.Time           `json:"created_at"`
}

type APIKey struct {
	ID            string   `json:"id"`
	PublicID      string   `json:"public_id"`
	DisplayPrefix string   `json:"display_prefix"`
	Name          string   `json:"name"`
	Scopes        []string `json:"scopes"`
	Status        string   `json:"status"`
	OwnerType     string   `json:"owner_type"`
	OwnerID       string   `json:"owner_id"`
	OrgID         *string  `json:"org_id,omitempty"`
	ExpiresAt     *int64   `json:"expires_at,omitempty"`
	RevokedAt     *int64   `json:"revoked_at,omitempty"`
	RevokedReason string   `json:"revoked_reason,omitempty"`
	CreatedAt     int64    `json:"created_at"`
	UpdatedAt     int64    `json:"updated_at"`
	LastUsedAt    *int64   `json:"last_used_at,omitempty"`
	UseCount      int64    `json:"use_count"`
	Secret        string   `json:"secret,omitempty"`
	KeyHash       string   `json:"-"`
}

type RBACRole struct {
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
	System      bool     `json:"system"`
	Version     int      `json:"version"`
}

type RBACAssignment struct {
	ID        string  `json:"id"`
	SubjectID string  `json:"subject_id"`
	RoleKey   string  `json:"role_key"`
	OrgID     string  `json:"org_id"`
	TeamID    string  `json:"team_id"`
	CreatedAt int64   `json:"created_at"`
	CreatedBy *string `json:"created_by,omitempty"`
}

type Session struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	TokenHash []byte    `json:"-"`
	ExpiresAt time.Time `json:"expires_at"`
	UserAgent string    `json:"user_agent"`
	IP        string    `json:"ip"`
}

type Organisation struct {
	ID        string    `json:"id"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type Role struct {
	ID           string              `json:"id"`
	OrgID        *string             `json:"org_id,omitempty"`
	Name         string              `json:"name"`
	Capabilities []access.Capability `json:"capabilities"`
}

type Membership struct {
	OrgID  string `json:"org_id"`
	UserID string `json:"user_id"`
	RoleID string `json:"role_id"`
	Role   Role   `json:"role"`
}

type Invitation struct {
	ID         string     `json:"id"`
	OrgID      string     `json:"org_id"`
	Email      string     `json:"email"`
	RoleID     string     `json:"role_id"`
	TokenHash  []byte     `json:"-"`
	ExpiresAt  time.Time  `json:"expires_at"`
	AcceptedAt *time.Time `json:"accepted_at,omitempty"`
}

type Project struct {
	ID            string    `json:"id"`
	OrgID         string    `json:"org_id"`
	Name          string    `json:"name"`
	Slug          string    `json:"slug"`
	Description   string    `json:"description"`
	Visibility    string    `json:"visibility"`
	DocsRoot      string    `json:"docs_root"`
	DefaultBranch string    `json:"default_branch"`
	PublishPolicy string    `json:"publish_policy"`
	Host          string    `json:"host"`
	BasePath      string    `json:"base_path"`
	CreatedAt     time.Time `json:"created_at"`
}

type GitConnection struct {
	ID               string    `json:"id"`
	OrgID            string    `json:"org_id"`
	Provider         string    `json:"provider"`
	DisplayName      string    `json:"display_name"`
	BaseURL          string    `json:"base_url"`
	AuthKind         string    `json:"auth_kind"`
	SecretCiphertext []byte    `json:"-"`
	CapabilitiesJSON []byte    `json:"-"`
	CreatedBy        *string   `json:"created_by,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
}

type ProjectBinding struct {
	ProjectID        string     `json:"project_id"`
	ConnectionID     string     `json:"connection_id"`
	RepoURL          string     `json:"repo_url"`
	RepoFullName     string     `json:"repo_full_name"`
	DefaultBranch    string     `json:"default_branch"`
	DocsRoot         string     `json:"docs_root"`
	GeneratedRoots   []string   `json:"generated_roots"`
	LastSyncedSHA    string     `json:"last_synced_sha"`
	LastSyncedAt     *time.Time `json:"last_synced_at,omitempty"`
	WebhookID        string     `json:"webhook_id"`
	WebhookSecret    []byte     `json:"-"`
	PollFallback     bool       `json:"poll_fallback"`
	Status           string     `json:"status"`
	StatusError      string     `json:"status_error"`
	WorkspaceRelpath string     `json:"workspace_relpath"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

type Job struct {
	ID          string     `json:"id"`
	OrgID       *string    `json:"org_id,omitempty"`
	ProjectID   *string    `json:"project_id,omitempty"`
	Kind        string     `json:"kind"`
	PayloadJSON []byte     `json:"-"`
	Status      string     `json:"status"`
	Attempts    int        `json:"attempts"`
	LastError   string     `json:"last_error"`
	RunAfter    time.Time  `json:"run_after"`
	LockedAt    *time.Time `json:"locked_at,omitempty"`
	LockedBy    string     `json:"locked_by"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type WebhookEvent struct {
	ID           string     `json:"id"`
	ConnectionID *string    `json:"connection_id,omitempty"`
	ProjectID    *string    `json:"project_id,omitempty"`
	Provider     string     `json:"provider"`
	DeliveryID   string     `json:"delivery_id"`
	EventType    string     `json:"event_type"`
	PayloadHash  []byte     `json:"-"`
	ProcessedAt  *time.Time `json:"processed_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

type EditLease struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	Path      string    `json:"path"`
	UserID    string    `json:"user_id"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
}

type DocVersion struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	Name      string    `json:"name"`
	Alias     string    `json:"alias"`
	GitRef    string    `json:"git_ref"`
	Immutable bool      `json:"immutable"`
	CreatedAt time.Time `json:"created_at"`
}

type PublishRun struct {
	ID           string     `json:"id"`
	ProjectID    string     `json:"project_id"`
	Target       string     `json:"target"`
	VersionName  string     `json:"version_name"`
	Status       string     `json:"status"`
	ArtifactPath string     `json:"artifact_path"`
	PublicURL    string     `json:"public_url"`
	Error        string     `json:"error"`
	CreatedAt    time.Time  `json:"created_at"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
}

type SearchDocument struct {
	ID          string `json:"id"`
	ProjectID   string `json:"project_id"`
	VersionName string `json:"version_name"`
	Path        string `json:"path"`
	Title       string `json:"title"`
	Headings    string `json:"headings"`
	Body        string `json:"body"`
	Keywords    string `json:"keywords"`
}

type MaintainerMapping struct {
	ID          string    `json:"id"`
	ProjectID   string    `json:"project_id"`
	SourceMatch string    `json:"source_match"`
	Extractor   string    `json:"extractor"`
	Output      string    `json:"output"`
	OptionsJSON []byte    `json:"options_json"`
	CreatedAt   time.Time `json:"created_at"`
}

type MaintainerSnapshot struct {
	ID         string    `json:"id"`
	ProjectID  string    `json:"project_id"`
	SourcePath string    `json:"source_path"`
	SourceSHA  string    `json:"source_sha"`
	IRJSON     []byte    `json:"ir_json"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type Redirect struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	FromPath  string `json:"from_path"`
	ToPath    string `json:"to_path"`
}

type Team struct {
	ID    string `json:"id"`
	OrgID string `json:"org_id"`
	Name  string `json:"name"`
}

type APIToken struct {
	ID         string     `json:"id"`
	UserID     string     `json:"user_id"`
	Name       string     `json:"name"`
	TokenHash  []byte     `json:"-"`
	Scopes     []string   `json:"scopes"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

type AuditEvent struct {
	ID          string    `json:"id"`
	ActorUserID *string   `json:"actor_user_id,omitempty"`
	OrgID       *string   `json:"org_id,omitempty"`
	ProjectID   *string   `json:"project_id,omitempty"`
	Action      string    `json:"action"`
	Target      string    `json:"target"`
	Metadata    []byte    `json:"-"`
	IP          string    `json:"ip"`
	CreatedAt   time.Time `json:"created_at"`
}
