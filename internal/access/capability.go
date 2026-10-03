package access

type Capability string

const (
	CapInstanceAdmin          Capability = "instance.admin"
	CapInstanceSettingsManage Capability = "instance.settings.manage"
	CapInstanceUsersManage    Capability = "instance.users.manage"
	CapInstanceAuditView      Capability = "instance.audit.view"

	CapOrgView             Capability = "org.view"
	CapOrgSettingsManage   Capability = "org.settings.manage"
	CapOrgMembersManage    Capability = "org.members.manage"
	CapOrgTeamsManage      Capability = "org.teams.manage"
	CapOrgProjectsCreate   Capability = "org.projects.create"
	CapOrgConnectionsManage Capability = "org.connections.manage"
	CapOrgAuditView        Capability = "org.audit.view"

	CapDocsView              Capability = "docs.view"
	CapDocsEdit              Capability = "docs.edit"
	CapDocsCreate            Capability = "docs.create"
	CapDocsDelete            Capability = "docs.delete"
	CapDocsPublish           Capability = "docs.publish"
	CapDocsAssetsManage      Capability = "docs.assets.manage"
	CapDocsVersionsManage    Capability = "docs.versions.manage"
	CapDocsSettingsManage    Capability = "docs.settings.manage"
	CapDocsMembersManage     Capability = "docs.members.manage"
	CapDocsGeneratedManage   Capability = "docs.generated.manage"
	CapDocsSearchReindex     Capability = "docs.search.reindex"
	CapProjectConnectionsManage Capability = "project.connections.manage"
	CapJobsView              Capability = "jobs.view"
	CapAuditView             Capability = "audit.view"
)

func AllInstanceCapabilities() []Capability {
	return []Capability{
		CapInstanceAdmin,
		CapInstanceSettingsManage,
		CapInstanceUsersManage,
		CapInstanceAuditView,
	}
}

type RolePreset struct {
	Name         string
	Capabilities []Capability
}

func SystemPresets() []RolePreset {
	viewer := []Capability{CapOrgView, CapDocsView, CapAuditView}
	writer := append(copyCaps(viewer), CapDocsEdit, CapDocsCreate, CapDocsAssetsManage)
	editor := append(copyCaps(writer), CapDocsDelete)
	publisher := append(copyCaps(editor), CapDocsPublish, CapDocsVersionsManage)
	maintainer := append(copyCaps(publisher), CapDocsGeneratedManage, CapJobsView, CapDocsSearchReindex)
	projectAdmin := append(copyCaps(maintainer), CapDocsSettingsManage, CapDocsMembersManage, CapProjectConnectionsManage)
	orgAdmin := append(copyCaps(projectAdmin),
		CapOrgSettingsManage, CapOrgMembersManage, CapOrgTeamsManage,
		CapOrgProjectsCreate, CapOrgConnectionsManage, CapOrgAuditView,
	)
	return []RolePreset{
		{Name: "Viewer", Capabilities: viewer},
		{Name: "Writer", Capabilities: writer},
		{Name: "Editor", Capabilities: editor},
		{Name: "Publisher", Capabilities: publisher},
		{Name: "Maintainer", Capabilities: maintainer},
		{Name: "Project Admin", Capabilities: projectAdmin},
		{Name: "Org Admin", Capabilities: orgAdmin},
	}
}

func copyCaps(in []Capability) []Capability {
	out := make([]Capability, len(in))
	copy(out, in)
	return out
}

func Has(have []Capability, want Capability) bool {
	if want == "" {
		return false
	}
	for _, c := range have {
		if c == want || c == CapInstanceAdmin && isInstanceCap(want) {
			return true
		}
	}
	return false
}

func isInstanceCap(c Capability) bool {
	switch c {
	case CapInstanceAdmin, CapInstanceSettingsManage, CapInstanceUsersManage, CapInstanceAuditView:
		return true
	default:
		return false
	}
}
