package grantex

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func authorityClaims() jwt.MapClaims {
	return jwt.MapClaims{"sub": "human-1", "jti": "token-1", "grnt": "grant-1", "agt": "did:grantex:agent-1", "dev": "tenant-1", "scp": []interface{}{"calendar:read"}, "iat": float64(time.Now().Unix()), "exp": float64(time.Now().Add(time.Hour).Unix())}
}

func TestGrantsVerifyCurrentAuthority(t *testing.T) {
	claims := authorityClaims()
	cases := []struct {
		name    string
		body    interface{}
		allowed bool
	}{
		{"active", map[string]interface{}{"active": true, "claims": claims}, true},
		{"inactive", map[string]interface{}{"active": false, "claims": claims}, false},
		{"string_false", map[string]interface{}{"active": "false", "claims": claims}, false},
		{"number", map[string]interface{}{"active": 1, "claims": claims}, false},
		{"missing", map[string]interface{}{"claims": claims}, false},
		{"null", nil, false}, {"array", []string{}, false},
		{"bad_claims", map[string]interface{}{"active": true, "claims": []string{}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/v1/grants/verify" || r.Header.Get("Authorization") != "Bearer synthetic-key" {
					t.Errorf("incorrect authority request")
				}
				var request map[string]string
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request["token"] != "synthetic-token" {
					t.Errorf("incorrect token request")
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(tc.body)
			}))
			defer server.Close()
			grant, err := NewClient("synthetic-key", WithBaseURL(server.URL)).Grants.Verify(context.Background(), "synthetic-token")
			if (err == nil) != tc.allowed {
				t.Fatalf("allowed=%v error=%v", tc.allowed, err)
			}
			if tc.allowed && grant.PrincipalID != "human-1" {
				t.Fatal("incorrect principal")
			}
		})
	}
}

func TestVerifyCurrentAuthorityIdentityAndRevocation(t *testing.T) {
	key := generateTestKey(t)
	server := startJWKSServer(t, key)
	defer server.Close()
	claims := authorityClaims()
	claims["iss"], claims["aud"] = server.URL, "tool-service"
	token := signTestToken(t, key, claims)
	local, err := normalizeGrantClaims(claims, true)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	opts := VerifyOptions{JwksURI: server.URL, Audience: "tool-service", ExpectedPrincipalID: "human-1", ExpectedAgentDID: "did:grantex:agent-1", CurrentAuthority: func(_ context.Context, input string) (*VerifiedGrant, error) {
		calls++
		if input != token {
			t.Fatal("authority got wrong token")
		}
		if calls == 1 {
			return local, nil
		}
		return nil, errors.New("revoked")
	}}
	if _, err := VerifyGrantToken(context.Background(), token, opts); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyGrantToken(context.Background(), token, opts); err == nil {
		t.Fatal("revoked token allowed")
	}
	if calls != 2 {
		t.Fatal("authority was cached")
	}
	opts.ExpectedPrincipalID = "different-human"
	if _, err := VerifyGrantToken(context.Background(), token, opts); err == nil {
		t.Fatal("wrong human allowed")
	}
	if calls != 2 {
		t.Fatal("wrong human reached issuer")
	}
	opts.ExpectedPrincipalID = "human-1"
	opts.CurrentAuthority = func(context.Context, string) (*VerifiedGrant, error) {
		other := *local
		other.AgentDID = "did:grantex:other"
		return &other, nil
	}
	if _, err := VerifyGrantToken(context.Background(), token, opts); err == nil {
		t.Fatal("substituted agent allowed")
	}
	opts.Audience = ""
	if _, err := VerifyGrantToken(context.Background(), token, opts); err == nil {
		t.Fatal("missing audience allowed")
	}
}

func TestRejectEmptyRequiredIdentities(t *testing.T) {
	for _, field := range []string{"sub", "jti"} {
		claims := authorityClaims()
		claims[field] = ""
		if _, err := normalizeGrantClaims(claims, true); err == nil {
			t.Fatalf("empty %s allowed", field)
		}
	}
}

func TestCurrentAuthorityRejectsSubstitutedClaims(t *testing.T) {
	key := generateTestKey(t)
	server := startJWKSServer(t, key)
	defer server.Close()
	claims := authorityClaims()
	claims["iss"], claims["aud"] = server.URL, "tool-service"
	token := signTestToken(t, key, claims)
	local, err := normalizeGrantClaims(claims, true)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		mutate func(*VerifiedGrant)
	}{
		{"issuer", func(g *VerifiedGrant) { g.Issuer = "https://other.example" }},
		{"audience", func(g *VerifiedGrant) { g.Audience = []string{"other-service"} }},
		{"principal", func(g *VerifiedGrant) { g.PrincipalID = "other-human" }},
		{"agent", func(g *VerifiedGrant) { g.AgentDID = "did:grantex:other" }},
		{"tenant", func(g *VerifiedGrant) { g.DeveloperID = "other-tenant" }},
		{"token", func(g *VerifiedGrant) { g.TokenID = "other-token" }},
		{"grant", func(g *VerifiedGrant) { g.GrantID = "other-grant" }},
		{"issued", func(g *VerifiedGrant) { g.IssuedAt++ }},
		{"expiry", func(g *VerifiedGrant) { g.ExpiresAt++ }},
		{"scope", func(g *VerifiedGrant) { g.Scopes = []string{"admin:all"} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := VerifyOptions{JwksURI: server.URL, Audience: "tool-service", CurrentAuthority: func(context.Context, string) (*VerifiedGrant, error) {
				other := *local
				tc.mutate(&other)
				return &other, nil
			}}
			if _, err := VerifyGrantToken(context.Background(), token, opts); err == nil {
				t.Fatal("substituted authority allowed")
			}
		})
	}
}
