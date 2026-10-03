package aspecmod

import (
	"strings"

	"lorelink.dev/lorelink/internal/access"
)

type Permission struct {
	Key         string `json:"key"`
	Description string `json:"description"`
	System      bool   `json:"system"`
}

type RoleDef struct {
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
	System      bool     `json:"system"`
}

func RoleKey(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = strings.ReplaceAll(s, " ", "-")
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if out == "" {
		return "role"
	}
	return out
}

func PermissionCatalog() []Permission {
	caps := []access.Capability{
		access.CapInstanceAdmin,
		access.CapInstanceSettingsManage,
		access.CapInstanceUsersManage,
		access.CapInstanceAuditView,
		access.CapOrgView,
		access.CapOrgSettingsManage,
		access.CapOrgMembersManage,
		access.CapOrgTeamsManage,
		access.CapOrgProjectsCreate,
		access.CapOrgConnectionsManage,
		access.CapOrgAuditView,
		access.CapDocsView,
		access.CapDocsEdit,
		access.CapDocsCreate,
		access.CapDocsDelete,
		access.CapDocsPublish,
		access.CapDocsAssetsManage,
		access.CapDocsVersionsManage,
		access.CapDocsSettingsManage,
		access.CapDocsMembersManage,
		access.CapDocsGeneratedManage,
		access.CapDocsSearchReindex,
		access.CapProjectConnectionsManage,
		access.CapJobsView,
		access.CapAuditView,
	}
	out := make([]Permission, 0, len(caps)+3)
	for _, c := range caps {
		out = append(out, Permission{Key: string(c), Description: string(c), System: true})
	}
	out = append(out,
		Permission{Key: "users:read", Description: "Read user accounts", System: true},
		Permission{Key: "users:update", Description: "Update user accounts", System: true},
		Permission{Key: "users:invite", Description: "Create user accounts and invitations", System: true},
		Permission{Key: "users:suspend", Description: "Suspend and activate accounts", System: true},
		Permission{Key: "api_keys:manage", Description: "Create and revoke API keys", System: true},
	)
	return out
}

func SystemRoleDefs() []RoleDef {
	out := make([]RoleDef, 0, len(access.SystemPresets())+1)
	for _, preset := range access.SystemPresets() {
		perms := make([]string, 0, len(preset.Capabilities))
		for _, c := range preset.Capabilities {
			perms = append(perms, string(c))
		}
		out = append(out, RoleDef{
			Key:         RoleKey(preset.Name),
			Name:        preset.Name,
			Description: "LoreLink system role",
			Permissions: perms,
			System:      true,
		})
	}
	out = append(out, RoleDef{
		Key:         "instance-admin",
		Name:        "Instance Admin",
		Description: "Full instance administration",
		Permissions: []string{string(access.CapInstanceAdmin)},
		System:      true,
	})
	return out
}
