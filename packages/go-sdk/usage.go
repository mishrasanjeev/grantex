package grantex

import (
	"context"
	"fmt"
)

// UsageService handles usage metering operations.
type UsageService struct {
	http *httpClient
}

// UsageResponse represents the current usage metrics.
type UsageResponse struct {
	DeveloperID    string `json:"developerId"`
	Period         string `json:"period"`
	TokenExchanges int    `json:"tokenExchanges"`
	Authorizations int    `json:"authorizations"`
	Verifications  int    `json:"verifications"`
	TotalRequests  int    `json:"totalRequests"`
}

// UsageHistoryEntry represents a single day's usage metrics.
type UsageHistoryEntry struct {
	Date           string `json:"date"`
	TokenExchanges int    `json:"tokenExchanges"`
	Authorizations int    `json:"authorizations"`
	Verifications  int    `json:"verifications"`
	TotalRequests  int    `json:"totalRequests"`
}

type usageHistoryResponse struct {
	Entries []UsageHistoryEntry `json:"entries"`
}

// Current retrieves the current period's usage metrics.
func (s *UsageService) Current(ctx context.Context) (*UsageResponse, error) {
	return unmarshal[UsageResponse](s.http.get(ctx, "/v1/usage"))
}

// History retrieves usage history for the specified number of days.
func (s *UsageService) History(ctx context.Context, days int) ([]UsageHistoryEntry, error) {
	resp, err := unmarshal[usageHistoryResponse](s.http.get(ctx, fmt.Sprintf("/v1/usage/history?days=%d", days)))
	if err != nil {
		return nil, err
	}
	return resp.Entries, nil
}
