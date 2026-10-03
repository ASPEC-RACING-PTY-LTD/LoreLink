package access

type Actor struct {
	UserID                string
	InstanceCapabilities  []Capability
	OrganisationCaps      []Capability
	ProjectCaps           []Capability
}

func (a Actor) Can(cap Capability) bool {
	if Has(a.InstanceCapabilities, CapInstanceAdmin) {
		return true
	}
	if Has(a.InstanceCapabilities, cap) {
		return true
	}
	if Has(a.OrganisationCaps, cap) {
		return true
	}
	return Has(a.ProjectCaps, cap)
}

func (a Actor) CanInstance(cap Capability) bool {
	if Has(a.InstanceCapabilities, CapInstanceAdmin) {
		return true
	}
	return Has(a.InstanceCapabilities, cap)
}
