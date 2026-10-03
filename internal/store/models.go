package store

import (
	"time"

	"lorelink.dev/lorelink/internal/access"
)

type Instance struct {
	ID               string
	Name             string
	PublicBaseURL    string
	PortalEnabled    bool
	SetupCompletedAt *time.Time
	CreatedAt        time.Time
}

type User struct {
	ID                    string
	Email                 string
	Name                  string
	PasswordHash          []byte
	PasswordSalt          []byte
	Status                string
	InstanceCapabilities  []access.Capability
	LastLoginAt           *time.Time
	CreatedAt             time.Time
}

type Session struct {
	ID        string
	UserID    string
	TokenHash []byte
	ExpiresAt time.Time
	UserAgent string
	IP        string
}

type Organisation struct {
	ID        string
	Slug      string
	Name      string
	CreatedAt time.Time
}

type Role struct {
	ID           string
	OrgID        *string
	Name         string
	Capabilities []access.Capability
}

type Membership struct {
	OrgID  string
	UserID string
	RoleID string
	Role   Role
}

type Invitation struct {
	ID        string
	OrgID     string
	Email     string
	RoleID    string
	TokenHash []byte
	ExpiresAt time.Time
	AcceptedAt *time.Time
}

type Project struct {
	ID            string
	OrgID         string
	Name          string
	Slug          string
	Description   string
	Visibility    string
	DocsRoot      string
	DefaultBranch string
	PublishPolicy string
	CreatedAt     time.Time
}

type AuditEvent struct {
	ID          string
	ActorUserID *string
	OrgID       *string
	ProjectID   *string
	Action      string
	Target      string
	Metadata    []byte
	IP          string
	CreatedAt   time.Time
}
