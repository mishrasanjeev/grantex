package grantex

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func generateTestKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("failed to generate RSA key: %v", err)
	}
	return key
}

func startJWKSServer(t *testing.T, key *rsa.PrivateKey) *httptest.Server {
	t.Helper()
	// Minimal JWKS response with the public key
	n := key.PublicKey.N
	e := key.PublicKey.E

	// Base64url encode n and e
	nBytes := n.Bytes()
	eBytes := big.NewInt(int64(e)).Bytes()

	jwks := map[string]interface{}{
		"keys": []map[string]interface{}{
			{
				"kty": "RSA",
				"kid": "test-kid-1",
				"use": "sig",
				"alg": "RS256",
				"n":   base64urlEncode(nBytes),
				"e":   base64urlEncode(eBytes),
			},
		},
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(jwks)
	}))
	return server
}

func base64urlEncode(data []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	result := make([]byte, 0, (len(data)*4+2)/3)
	for i := 0; i < len(data); i += 3 {
		var b0, b1, b2 byte
		b0 = data[i]
		if i+1 < len(data) {
			b1 = data[i+1]
		}
		if i+2 < len(data) {
			b2 = data[i+2]
		}
		result = append(result, alphabet[b0>>2])
		result = append(result, alphabet[((b0&0x03)<<4)|(b1>>4)])
		if i+1 < len(data) {
			result = append(result, alphabet[((b1&0x0f)<<2)|(b2>>6)])
		}
		if i+2 < len(data) {
			result = append(result, alphabet[b2&0x3f])
		}
	}
	return string(result)
}

func signTestToken(t *testing.T, key *rsa.PrivateKey, claims jwt.MapClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = "test-kid-1"
	tokenStr, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("failed to sign token: %v", err)
	}
	return tokenStr
}

func TestVerifyGrantTokenValid(t *testing.T) {
	key := generateTestKey(t)
	jwksServer := startJWKSServer(t, key)
	defer jwksServer.Close()

	now := time.Now()
	tokenStr := signTestToken(t, key, jwt.MapClaims{
		"iss":  jwksServer.URL,
		"sub":  "user-123",
		"agt":  "did:grantex:agent-1",
		"dev":  "dev-456",
		"scp":  []string{"read:email", "send:email"},
		"iat":  now.Unix(),
		"exp":  now.Add(1 * time.Hour).Unix(),
		"jti":  "token-789",
		"grnt": "grant-abc",
	})

	grant, err := VerifyGrantToken(context.Background(), tokenStr, VerifyOptions{
		JwksURI: jwksServer.URL,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if grant.TokenID != "token-789" {
		t.Errorf("expected token-789, got %s", grant.TokenID)
	}
	if grant.GrantID != "grant-abc" {
		t.Errorf("expected grant-abc, got %s", grant.GrantID)
	}
	if grant.PrincipalID != "user-123" {
		t.Errorf("expected user-123, got %s", grant.PrincipalID)
	}
	if grant.AgentDID != "did:grantex:agent-1" {
		t.Errorf("expected did:grantex:agent-1, got %s", grant.AgentDID)
	}
	if grant.DeveloperID != "dev-456" {
		t.Errorf("expected dev-456, got %s", grant.DeveloperID)
	}
	if len(grant.Scopes) != 2 {
		t.Errorf("expected 2 scopes, got %d", len(grant.Scopes))
	}
}

func TestVerifyGrantTokenGrantIDFallback(t *testing.T) {
	key := generateTestKey(t)
	jwksServer := startJWKSServer(t, key)
	defer jwksServer.Close()

	now := time.Now()
	tokenStr := signTestToken(t, key, jwt.MapClaims{
		"iss": jwksServer.URL,
		"sub": "user-1",
		"agt": "did:grantex:a",
		"dev": "dev-1",
		"scp": []string{"read"},
		"iat": now.Unix(),
		"exp": now.Add(1 * time.Hour).Unix(),
		"jti": "token-fallback",
		// no "grnt" claim — should fall back to jti
	})

	grant, err := VerifyGrantToken(context.Background(), tokenStr, VerifyOptions{
		JwksURI: jwksServer.URL,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if grant.GrantID != "token-fallback" {
		t.Errorf("expected grant ID to fall back to jti, got %s", grant.GrantID)
	}
}

func TestVerifyGrantTokenDelegation(t *testing.T) {
	key := generateTestKey(t)
	jwksServer := startJWKSServer(t, key)
	defer jwksServer.Close()

	now := time.Now()
	tokenStr := signTestToken(t, key, jwt.MapClaims{
		"iss":             jwksServer.URL,
		"sub":             "user-1",
		"agt":             "did:grantex:sub-agent",
		"dev":             "dev-1",
		"scp":             []string{"read:email"},
		"iat":             now.Unix(),
		"exp":             now.Add(1 * time.Hour).Unix(),
		"jti":             "token-del",
		"grnt":            "grant-del",
		"parentAgt":       "did:grantex:parent-agent",
		"parentGrnt":      "grant-parent",
		"delegationDepth": 1,
	})

	grant, err := VerifyGrantToken(context.Background(), tokenStr, VerifyOptions{
		JwksURI: jwksServer.URL,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if grant.ParentAgentDID == nil || *grant.ParentAgentDID != "did:grantex:parent-agent" {
		t.Error("expected parentAgentDid")
	}
	if grant.ParentGrantID == nil || *grant.ParentGrantID != "grant-parent" {
		t.Error("expected parentGrantId")
	}
	if grant.DelegationDepth == nil || *grant.DelegationDepth != 1 {
		t.Error("expected delegationDepth=1")
	}
}

func TestVerifyGrantTokenExpired(t *testing.T) {
	key := generateTestKey(t)
	jwksServer := startJWKSServer(t, key)
	defer jwksServer.Close()

	past := time.Now().Add(-2 * time.Hour)
	tokenStr := signTestToken(t, key, jwt.MapClaims{
		"iss": jwksServer.URL,
		"sub": "user-1",
		"agt": "did:grantex:a",
		"dev": "dev-1",
		"scp": []string{"read"},
		"iat": past.Unix(),
		"exp": past.Add(1 * time.Hour).Unix(), // expired 1h ago
		"jti": "expired-token",
	})

	_, err := VerifyGrantToken(context.Background(), tokenStr, VerifyOptions{
		JwksURI: jwksServer.URL,
	})
	if err == nil {
		t.Fatal("expected error for expired token")
	}
	tokenErr, ok := err.(*TokenError)
	if !ok {
		t.Fatalf("expected TokenError, got %T", err)
	}
	if tokenErr.Message != "token verification failed" {
		t.Errorf("unexpected message: %s", tokenErr.Message)
	}
}

func TestVerifyGrantTokenRequiredScopes(t *testing.T) {
	key := generateTestKey(t)
	jwksServer := startJWKSServer(t, key)
	defer jwksServer.Close()

	now := time.Now()
	tokenStr := signTestToken(t, key, jwt.MapClaims{
		"iss": jwksServer.URL,
		"sub": "user-1",
		"agt": "did:grantex:a",
		"dev": "dev-1",
		"scp": []string{"read:email"},
		"iat": now.Unix(),
		"exp": now.Add(1 * time.Hour).Unix(),
		"jti": "token-scope",
	})

	// Should succeed with matching scope
	_, err := VerifyGrantToken(context.Background(), tokenStr, VerifyOptions{
		JwksURI:        jwksServer.URL,
		RequiredScopes: []string{"read:email"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should fail with missing scope
	_, err = VerifyGrantToken(context.Background(), tokenStr, VerifyOptions{
		JwksURI:        jwksServer.URL,
		RequiredScopes: []string{"write:email"},
	})
	if err == nil {
		t.Fatal("expected error for missing scope")
	}
	tokenErr, ok := err.(*TokenError)
	if !ok {
		t.Fatalf("expected TokenError, got %T", err)
	}
	if tokenErr.Message != "missing required scope: write:email" {
		t.Errorf("unexpected message: %s", tokenErr.Message)
	}
}

func TestVerifyGrantTokenRejectsWrongIssuer(t *testing.T) {
	key := generateTestKey(t)
	jwksServer := startJWKSServer(t, key)
	defer jwksServer.Close()

	now := time.Now()
	tokenStr := signTestToken(t, key, jwt.MapClaims{
		"iss": "https://attacker.example",
		"sub": "user-1",
		"agt": "did:grantex:a",
		"dev": "dev-1",
		"scp": []string{"read"},
		"iat": now.Unix(),
		"exp": now.Add(1 * time.Hour).Unix(),
		"jti": "wrong-issuer",
	})

	_, err := VerifyGrantToken(context.Background(), tokenStr, VerifyOptions{
		JwksURI: jwksServer.URL,
	})
	if err == nil {
		t.Fatal("expected error for wrong issuer")
	}
	if _, ok := err.(*TokenError); !ok {
		t.Fatalf("expected TokenError, got %T", err)
	}
}

func TestVerifyGrantTokenRequiresCoreClaims(t *testing.T) {
	key := generateTestKey(t)
	jwksServer := startJWKSServer(t, key)
	defer jwksServer.Close()

	now := time.Now()
	baseClaims := jwt.MapClaims{
		"iss": jwksServer.URL,
		"sub": "user-1",
		"agt": "did:grantex:a",
		"dev": "dev-1",
		"scp": []string{"read"},
		"iat": now.Unix(),
		"exp": now.Add(1 * time.Hour).Unix(),
		"jti": "required-claims",
	}

	for _, missing := range []string{"iss", "jti", "sub", "agt", "dev", "scp", "iat", "exp"} {
		t.Run(missing, func(t *testing.T) {
			claims := make(jwt.MapClaims, len(baseClaims)-1)
			for name, value := range baseClaims {
				if name != missing {
					claims[name] = value
				}
			}

			tokenStr := signTestToken(t, key, claims)
			_, err := VerifyGrantToken(context.Background(), tokenStr, VerifyOptions{
				JwksURI: jwksServer.URL,
			})
			if err == nil {
				t.Fatalf("expected error when %s is missing", missing)
			}
			if _, ok := err.(*TokenError); !ok {
				t.Fatalf("expected TokenError, got %T", err)
			}
		})
	}
}

func TestVerifyGrantTokenRejectsInvalidScopeClaim(t *testing.T) {
	key := generateTestKey(t)
	jwksServer := startJWKSServer(t, key)
	defer jwksServer.Close()

	now := time.Now()
	tokenStr := signTestToken(t, key, jwt.MapClaims{
		"iss": jwksServer.URL,
		"sub": "user-1",
		"agt": "did:grantex:a",
		"dev": "dev-1",
		"scp": []interface{}{"read", 123},
		"iat": now.Unix(),
		"exp": now.Add(1 * time.Hour).Unix(),
		"jti": "invalid-scope",
	})

	_, err := VerifyGrantToken(context.Background(), tokenStr, VerifyOptions{
		JwksURI: jwksServer.URL,
	})
	if err == nil {
		t.Fatal("expected error for invalid scope claim")
	}
	if _, ok := err.(*TokenError); !ok {
		t.Fatalf("expected TokenError, got %T", err)
	}
}

func TestDeriveIssuerFromJwksURI(t *testing.T) {
	tests := []struct {
		name    string
		jwksURI string
		want    string
	}{
		{
			name:    "hosted production alias",
			jwksURI: "https://api.grantex.dev/.well-known/jwks.json/",
			want:    "https://grantex.dev",
		},
		{
			name:    "custom well-known path",
			jwksURI: "https://auth.example.com/tenant/.well-known/jwks.json",
			want:    "https://auth.example.com/tenant",
		},
		{
			name:    "custom key path",
			jwksURI: "https://auth.example.com/tenant/keys/",
			want:    "https://auth.example.com/tenant/keys",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := deriveIssuerFromJwksURI(tt.jwksURI)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("expected %s, got %s", tt.want, got)
			}
		})
	}

	if _, err := deriveIssuerFromJwksURI("not-a-url"); err == nil {
		t.Fatal("expected invalid URL error")
	}
}

func TestResolveVerificationEndpointsFromIssuerDID(t *testing.T) {
	jwksURI, issuer, err := resolveVerificationEndpoints(VerifyOptions{
		JwksURI:   "https://ignored.example/.well-known/jwks.json",
		IssuerDID: "did:web:auth.example.com:tenant",
		Issuer:    "https://canonical.example",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if jwksURI != "https://auth.example.com/tenant/.well-known/jwks.json" {
		t.Fatalf("unexpected JWKS URI: %s", jwksURI)
	}
	if issuer != "https://canonical.example" {
		t.Fatalf("unexpected issuer: %s", issuer)
	}
}

func TestVerifyGrantTokenNoJwksURI(t *testing.T) {
	_, err := VerifyGrantToken(context.Background(), "some-token", VerifyOptions{})
	if err == nil {
		t.Fatal("expected error for missing jwksUri")
	}
	tokenErr, ok := err.(*TokenError)
	if !ok {
		t.Fatalf("expected TokenError, got %T", err)
	}
	if tokenErr.Message != "jwksUri is required" {
		t.Errorf("unexpected message: %s", tokenErr.Message)
	}
}

func TestVerifyGrantTokenInvalidToken(t *testing.T) {
	key := generateTestKey(t)
	jwksServer := startJWKSServer(t, key)
	defer jwksServer.Close()

	_, err := VerifyGrantToken(context.Background(), "not-a-jwt", VerifyOptions{
		JwksURI: jwksServer.URL,
	})
	if err == nil {
		t.Fatal("expected error for invalid token")
	}
	_, ok := err.(*TokenError)
	if !ok {
		t.Fatalf("expected TokenError, got %T", err)
	}
}
