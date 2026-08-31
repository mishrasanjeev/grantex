package grantex

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

type refreshRetryKey struct {
	key       string
	expiresAt time.Time
}

// TokensService handles token exchange, refresh, verification, and revocation.
type TokensService struct {
	http             *httpClient
	refreshRetryMu   sync.Mutex
	refreshRetryKeys map[string]refreshRetryKey
}

// Exchange trades an authorization code for a grant token.
func (s *TokensService) Exchange(ctx context.Context, params ExchangeTokenParams) (*ExchangeTokenResponse, error) {
	return unmarshal[ExchangeTokenResponse](s.http.post(ctx, "/v1/token", params))
}

// Refresh exchanges a refresh token for a new grant token.
func (s *TokensService) Refresh(ctx context.Context, params RefreshTokenParams) (*ExchangeTokenResponse, error) {
	now := time.Now()
	s.refreshRetryMu.Lock()
	if s.refreshRetryKeys == nil {
		s.refreshRetryKeys = make(map[string]refreshRetryKey)
	}
	for token, retry := range s.refreshRetryKeys {
		if !retry.expiresAt.After(now) {
			delete(s.refreshRetryKeys, token)
		}
	}
	idempotencyKey := params.IdempotencyKey
	if idempotencyKey == "" {
		if cached, ok := s.refreshRetryKeys[params.RefreshToken]; ok && cached.expiresAt.After(now) {
			idempotencyKey = cached.key
		}
	}
	if idempotencyKey == "" {
		value := make([]byte, 16)
		if _, err := rand.Read(value); err != nil {
			s.refreshRetryMu.Unlock()
			return nil, &NetworkError{Message: "failed to generate refresh idempotency key", Cause: err}
		}
		idempotencyKey = hex.EncodeToString(value)
	}
	s.refreshRetryKeys[params.RefreshToken] = refreshRetryKey{key: idempotencyKey, expiresAt: now.Add(5 * time.Minute)}
	s.refreshRetryMu.Unlock()

	response, err := unmarshal[ExchangeTokenResponse](s.http.postWithHeaders(
		ctx,
		"/v1/token/refresh",
		params,
		map[string]string{"Idempotency-Key": idempotencyKey},
	))
	if err != nil {
		return nil, err
	}
	s.refreshRetryMu.Lock()
	delete(s.refreshRetryKeys, params.RefreshToken)
	s.refreshRetryMu.Unlock()
	return response, nil
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
