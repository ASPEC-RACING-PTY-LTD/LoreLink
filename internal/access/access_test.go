package access

import "testing"

func TestHasInstanceAdminImpliesInstanceCaps(t *testing.T) {
	t.Parallel()
	if !Has([]Capability{CapInstanceAdmin}, CapInstanceUsersManage) {
		t.Fatal("instance.admin should imply instance.users.manage")
	}
	if Has([]Capability{CapInstanceAdmin}, CapDocsEdit) {
		t.Fatal("instance.admin should not imply docs.edit through Has; Actor.Can does")
	}
}

func TestActorCan(t *testing.T) {
	t.Parallel()
	writer := Actor{OrganisationCaps: []Capability{CapDocsView, CapDocsEdit}}
	if !writer.Can(CapDocsEdit) {
		t.Fatal("writer should edit")
	}
	if writer.Can(CapDocsPublish) {
		t.Fatal("writer should not publish")
	}
	if writer.CanInstance(CapInstanceAdmin) {
		t.Fatal("writer should not be instance admin")
	}
}

func TestActorInstanceAdminBypasses(t *testing.T) {
	t.Parallel()
	admin := Actor{InstanceCapabilities: []Capability{CapInstanceAdmin}}
	if !admin.Can(CapDocsPublish) {
		t.Fatal("instance admin can act on any cap in Phase 0")
	}
	if !admin.CanInstance(CapInstanceAuditView) {
		t.Fatal("instance admin can view instance audit")
	}
}

func TestSystemPresetsViewerCannotPublish(t *testing.T) {
	t.Parallel()
	var viewer RolePreset
	for _, p := range SystemPresets() {
		if p.Name == "Viewer" {
			viewer = p
		}
	}
	if Has(viewer.Capabilities, CapDocsPublish) {
		t.Fatal("viewer must not publish")
	}
	if !Has(viewer.Capabilities, CapDocsView) {
		t.Fatal("viewer must view")
	}
}
