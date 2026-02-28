package grantex

import "context"

// PoliciesService handles access policy management.
type PoliciesService struct {
	http *httpClient
}

// Create creates a new access policy.
func (s *PoliciesService) Create(ctx context.Context, params CreatePolicyParams) (*Policy, error) {
	return unmarshal[Policy](s.http.post(ctx, "/v1/policies", params))
}

// List retrieves all policies.
func (s *PoliciesService) List(ctx context.Context) (*ListPoliciesResponse, error) {
	return unmarshal[ListPoliciesResponse](s.http.get(ctx, "/v1/policies"))
}

// Get retrieves a policy by ID.
func (s *PoliciesService) Get(ctx context.Context, policyID string) (*Policy, error) {
	return unmarshal[Policy](s.http.get(ctx, "/v1/policies/"+policyID))
}

// Update modifies an existing policy.
func (s *PoliciesService) Update(ctx context.Context, policyID string, params UpdatePolicyParams) (*Policy, error) {
	return unmarshal[Policy](s.http.patch(ctx, "/v1/policies/"+policyID, params))
}

// Delete removes a policy.
func (s *PoliciesService) Delete(ctx context.Context, policyID string) error {
	_, err := s.http.del(ctx, "/v1/policies/"+policyID)
	return err
}
