package grantex

import "context"

// TokensService handles token exchange, refresh, verification, and revocation.
type TokensService struct {
	http *httpClient
}

// Exchange trades an authorization code for a grant token.
func (s *TokensService) Exchange(ctx context.Context, params ExchangeTokenParams) (*ExchangeTokenResponse, error) {
	return unmarshal[ExchangeTokenResponse](s.http.post(ctx, "/v1/token", params))
}

// Refresh exchanges a refresh token for a new grant token.
func (s *TokensService) Refresh(ctx context.Context, params RefreshTokenParams) (*ExchangeTokenResponse, error) {
	return unmarshal[ExchangeTokenResponse](s.http.post(ctx, "/v1/token/refresh", params))
}

// Verify performs online token verification.
func (s *TokensService) Verify(ctx context.Context, token string) (*VerifyTokenResponse, error) {
	body := map[string]string{"token": token}
	return unmarshal[VerifyTokenResponse](s.http.post(ctx, "/v1/tokens/verify", body))
}

// Revoke revokes a token by its ID.
func (s *TokensService) Revoke(ctx context.Context, tokenID string) error {
	body := map[string]string{"jti": tokenID}
	_, err := s.http.post(ctx, "/v1/tokens/revoke", body)
	return err
}
