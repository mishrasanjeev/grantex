package grantex

import "context"

// AgentsService handles agent registration and management.
type AgentsService struct {
	http *httpClient
}

// Register creates a new agent.
func (s *AgentsService) Register(ctx context.Context, params RegisterAgentParams) (*Agent, error) {
	return unmarshal[Agent](s.http.post(ctx, "/v1/agents", params))
}

// Get retrieves an agent by ID.
func (s *AgentsService) Get(ctx context.Context, agentID string) (*Agent, error) {
	return unmarshal[Agent](s.http.get(ctx, "/v1/agents/"+agentID))
}

// List retrieves all agents for the current developer.
func (s *AgentsService) List(ctx context.Context) (*ListAgentsResponse, error) {
	return unmarshal[ListAgentsResponse](s.http.get(ctx, "/v1/agents"))
}

// Update modifies an existing agent.
func (s *AgentsService) Update(ctx context.Context, agentID string, params UpdateAgentParams) (*Agent, error) {
	return unmarshal[Agent](s.http.patch(ctx, "/v1/agents/"+agentID, params))
}

// Delete removes an agent.
func (s *AgentsService) Delete(ctx context.Context, agentID string) error {
	_, err := s.http.del(ctx, "/v1/agents/"+agentID)
	return err
}
