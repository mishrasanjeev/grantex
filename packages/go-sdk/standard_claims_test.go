package grantex

import (
	"context"
	"crypto/elliptic"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/lestrrat-go/jwx/v2/jwk"
)

type grantTokenFixture struct {
	Standard      map[string]interface{} `json:"standard"`
	LegacyAliases map[string]interface{} `json:"legacy_aliases"`
}

// The profile example lives in spec/examples; testdata holds a copy so the
// Go module's tests also run outside the monorepo.
const specFixturePath = "../../spec/examples/grant-token-0.6.json"

func TestGrantTokenFixtureMatchesTheSpecExample(t *testing.T) {
	spec, err := os.ReadFile(filepath.FromSlash(specFixturePath))
	if os.IsNotExist(err) {
		t.Skip("spec/examples is not present outside the monorepo")
	}
	if err != nil {
		t.Fatalf("read spec example: %v", err)
	}
	local, err := os.ReadFile(filepath.Join("testdata", "grant-token-0.6.json"))
	if err != nil {
		t.Fatalf("read testdata copy: %v", err)
	}
	normalize := func(b []byte) string { return strings.ReplaceAll(string(b), "\r\n", "\n") }
	if normalize(spec) != normalize(local) {
		t.Fatal("testdata/grant-token-0.6.json differs from spec/examples/grant-token-0.6.json; copy the spec example")
	}
}

func loadGrantTokenFixture(t *testing.T) grantTokenFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "grant-token-0.6.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture grantTokenFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return fixture
}

func fixtureClaims(base map[string]interface{}, iss string, extra map[string]interface{}) jwt.MapClaims {
	claims := jwt.MapClaims{}
	for name, value := range base {
		claims[name] = value
	}
	now := time.Now()
	claims["iss"] = iss
	claims["iat"] = now.Unix()
	claims["exp"] = now.Add(10 * time.Minute).Unix()
	for name, value := range extra {
		if value == nil {
			delete(claims, name)
		} else {
			claims[name] = value
		}
	}
	return claims
}

func signFixture(t *testing.T, claims jwt.MapClaims, typ string) (string, *VerifyOptions) {
	t.Helper()
	key := generateECKey(t, elliptic.P256())
	server := serveKeys(t, publicJWK(t, &key.PublicKey, "ec-1", "ES256"))
	claims["iss"] = server.URL
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["kid"] = "ec-1"
	token.Header["typ"] = typ
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed, &VerifyOptions{JwksURI: server.URL}
}

func TestStockJWTLibraryValidatesTheStandardFormToken(t *testing.T) {
	fixture := loadGrantTokenFixture(t)
	key := generateECKey(t, elliptic.P256())
	jwksServer := serveKeys(t, publicJWK(t, &key.PublicKey, "ec-1", "ES256"))
	claims := fixtureClaims(fixture.Standard, jwksServer.URL, nil)
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["kid"] = "ec-1"
	token.Header["typ"] = "at+jwt"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	set, err := jwk.Fetch(context.Background(), jwksServer.URL)
	if err != nil {
		t.Fatalf("fetch jwks: %v", err)
	}
	parsed, err := jwt.Parse(signed, func(tok *jwt.Token) (interface{}, error) {
		entry, _ := set.LookupKeyID(tok.Header["kid"].(string))
		var raw interface{}
		return raw, entry.Raw(&raw)
	},
		jwt.WithValidMethods([]string{"RS256", "ES256"}),
		jwt.WithIssuer(jwksServer.URL),
		jwt.WithAudience("https://agents.example.com"),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
	)
	if err != nil {
		t.Fatalf("stock verification: %v", err)
	}
	payload := parsed.Claims.(jwt.MapClaims)
	if parsed.Header["typ"] != "at+jwt" || payload["client_id"] != "ag_01UNDERWRITER" || payload["jti"] == nil {
		t.Fatalf("unexpected standard claims: %v %v", parsed.Header, payload)
	}
	if got := strings.Split(payload["scope"].(string), " "); !reflect.DeepEqual(got, []string{"tool:acme_kyb:read", "tool:acme_kyb:write"}) {
		t.Fatalf("scope = %v", got)
	}
	if payload["act"].(map[string]interface{})["sub"] != "did:grantex:ag_01ORCHESTRATOR" {
		t.Fatalf("act = %v", payload["act"])
	}
}

func TestVerifyGrantTokenReadsStandardClaimsOnly(t *testing.T) {
	fixture := loadGrantTokenFixture(t)
	signed, opts := signFixture(t, fixtureClaims(fixture.Standard, "", nil), "at+jwt")
	opts.StandardClaimsOnly = true
	opts.OnLegacyClaim = func(alias, standard string) { t.Fatalf("unexpected legacy alias %s", alias) }

	grant, err := VerifyGrantToken(context.Background(), signed, *opts)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if grant.GrantID != "grnt_01EXAMPLECHILD" || grant.AgentDID != "did:grantex:ag_01UNDERWRITER" ||
		grant.DeveloperID != "dev_01EXAMPLE" || grant.PrincipalID != "user_01EXAMPLEPRINCIPAL" {
		t.Fatalf("unexpected grant: %+v", grant)
	}
	if !reflect.DeepEqual(grant.Scopes, []string{"tool:acme_kyb:read", "tool:acme_kyb:write"}) {
		t.Fatalf("scopes = %v", grant.Scopes)
	}
	if grant.ParentAgentDID == nil || *grant.ParentAgentDID != "did:grantex:ag_01ORCHESTRATOR" ||
		grant.ParentGrantID == nil || *grant.ParentGrantID != "grnt_01EXAMPLEPARENT" ||
		grant.DelegationDepth == nil || *grant.DelegationDepth != 2 {
		t.Fatalf("delegation fields: %+v", grant)
	}
	wantAct := &ActorClaim{Sub: "did:grantex:ag_01ORCHESTRATOR", Act: &ActorClaim{Sub: "did:grantex:ag_01INTAKE"}}
	if !reflect.DeepEqual(grant.Act, wantAct) {
		t.Fatalf("act = %+v", grant.Act)
	}
	if grant.Cnf["jkt"] == nil || len(grant.AuthorizationDetails) != 2 ||
		!reflect.DeepEqual(grant.Audience, []string{"https://agents.example.com"}) || len(grant.LegacyClaimsUsed) != 0 {
		t.Fatalf("cnf/details/audience/legacy: %+v", grant)
	}
}

func TestVerifyGrantTokenStandardClaimsOnlyRefusesLegacyTokensAndOtherTyp(t *testing.T) {
	fixture := loadGrantTokenFixture(t)
	legacyOnly := fixtureClaims(fixture.LegacyAliases, "", map[string]interface{}{"sub": "user-1", "jti": "tok-old"})
	signed, opts := signFixture(t, legacyOnly, "at+jwt")
	opts.StandardClaimsOnly = true
	expectRejected(t, signed, *opts)

	signed, opts = signFixture(t, fixtureClaims(fixture.Standard, "", nil), "JWT")
	opts.StandardClaimsOnly = true
	expectRejected(t, signed, *opts)
}

func TestVerifyGrantTokenReadsLegacyAliasesByDefaultAndReportsThem(t *testing.T) {
	fixture := loadGrantTokenFixture(t)
	legacyOnly := fixtureClaims(fixture.LegacyAliases, "", map[string]interface{}{
		"sub": "user-1", "jti": "tok-old", "act": map[string]interface{}{"sub": "did:grantex:ag_01ORCHESTRATOR"},
	})
	signed, opts := signFixture(t, legacyOnly, "at+jwt")
	var reported []string
	opts.OnLegacyClaim = func(alias, standard string) { reported = append(reported, alias+"->"+standard) }

	grant, err := VerifyGrantToken(context.Background(), signed, *opts)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	want := []string{"scp", "agt", "dev", "grnt", "parentGrnt", "delegationDepth"}
	if !reflect.DeepEqual(grant.LegacyClaimsUsed, want) {
		t.Fatalf("LegacyClaimsUsed = %v", grant.LegacyClaimsUsed)
	}
	if len(reported) != len(want) || reported[0] != "scp->scope" {
		t.Fatalf("reported = %v", reported)
	}
	if grant.AgentDID != "did:grantex:ag_01UNDERWRITER" || *grant.ParentAgentDID != "did:grantex:ag_01ORCHESTRATOR" {
		t.Fatalf("unexpected grant: %+v", grant)
	}

	// Both forms together: no alias is relied on.
	signed, opts = signFixture(t, fixtureClaims(fixture.Standard, "", fixture.LegacyAliases), "at+jwt")
	opts.OnLegacyClaim = func(alias, standard string) { t.Fatalf("unexpected legacy alias %s", alias) }
	if _, err := VerifyGrantToken(context.Background(), signed, *opts); err != nil {
		t.Fatalf("verify both forms: %v", err)
	}
}

func TestVerifyGrantTokenRefusesDisagreeingAliases(t *testing.T) {
	fixture := loadGrantTokenFixture(t)
	for name, alias := range map[string]map[string]interface{}{
		"scp":             {"scp": []string{"tool:acme_kyb:read"}},
		"agt":             {"agt": "did:grantex:ag_OTHER"},
		"dev":             {"dev": "dev_OTHER"},
		"grnt":            {"grnt": "grnt_OTHER"},
		"parentAgt":       {"parentAgt": "did:grantex:ag_OTHER"},
		"parentGrnt":      {"parentGrnt": "grnt_OTHER"},
		"delegationDepth": {"delegationDepth": 1},
	} {
		t.Run(name, func(t *testing.T) {
			signed, opts := signFixture(t, fixtureClaims(fixture.Standard, "", alias), "at+jwt")
			_, err := VerifyGrantToken(context.Background(), signed, *opts)
			tokenErr, ok := err.(*TokenError)
			if !ok || !strings.Contains(tokenErr.Message, "disagrees with its legacy alias") {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestVerifyGrantTokenRefusesMalformedStandardClaims(t *testing.T) {
	fixture := loadGrantTokenFixture(t)
	chain := map[string]interface{}{"sub": "did:grantex:ag_0"}
	for i := 1; i <= 10; i++ {
		chain = map[string]interface{}{"sub": "did:grantex:ag_n", "act": chain}
	}
	for name, extra := range map[string]map[string]interface{}{
		"scope array":     {"scope": []string{"read"}},
		"grant string":    {GrantClaim: "grnt"},
		"act without sub": {"act": map[string]interface{}{"iss": "x"}},
		"act too deep":    {"act": chain},
		"cnf string":      {"cnf": "jkt"},
	} {
		t.Run(name, func(t *testing.T) {
			signed, opts := signFixture(t, fixtureClaims(fixture.Standard, "", extra), "at+jwt")
			expectRejected(t, signed, *opts)
		})
	}
}
