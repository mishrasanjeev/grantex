package grantex

import (
	"context"
	"crypto/elliptic"
	"encoding/json"
	"fmt"
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

// testdata/grant-token-0.6.issued.json is a copy of
// spec/examples/grant-token-0.6.issued.json: tokens issued by the auth
// service (apps/auth-service/tests/grant-token-issued-fixture.test.ts) and the
// JWK Set that verifies them.
type issuedTokensFixture struct {
	Issuer   string                    `json:"issuer"`
	Audience string                    `json:"audience"`
	JWKS     map[string]interface{}    `json:"jwks"`
	Tokens   map[string]issuedTokenRef `json:"tokens"`
}

type issuedTokenRef struct {
	Alg   string `json:"alg"`
	Kid   string `json:"kid"`
	Token string `json:"token"`
}

func loadIssuedTokens(t *testing.T) issuedTokensFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "grant-token-0.6.issued.json"))
	if err != nil {
		t.Fatalf("read issued fixture: %v", err)
	}
	var fixture issuedTokensFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse issued fixture: %v", err)
	}
	return fixture
}

func TestIssuedTokensFixtureMatchesTheSpecExample(t *testing.T) {
	spec, err := os.ReadFile(filepath.FromSlash("../../spec/examples/grant-token-0.6.issued.json"))
	if os.IsNotExist(err) {
		t.Skip("spec/examples is not present outside the monorepo")
	}
	if err != nil {
		t.Fatalf("read spec example: %v", err)
	}
	local, err := os.ReadFile(filepath.Join("testdata", "grant-token-0.6.issued.json"))
	if err != nil {
		t.Fatalf("read testdata copy: %v", err)
	}
	normalize := func(b []byte) string { return strings.ReplaceAll(string(b), "\r\n", "\n") }
	if normalize(spec) != normalize(local) {
		t.Fatal("testdata/grant-token-0.6.issued.json differs from spec/examples; copy the spec example")
	}
}

func TestStockJWTLibraryValidatesTheStandardFormToken(t *testing.T) {
	fixture := loadIssuedTokens(t)
	encoded, err := json.Marshal(fixture.JWKS)
	if err != nil {
		t.Fatalf("marshal jwks: %v", err)
	}
	set, err := jwk.Parse(encoded)
	if err != nil {
		t.Fatalf("parse jwks: %v", err)
	}

	for _, name := range []string{"standard_rs256", "standard_es256"} {
		t.Run(name, func(t *testing.T) {
			parsed, err := jwt.Parse(fixture.Tokens[name].Token, func(tok *jwt.Token) (interface{}, error) {
				kid, ok := tok.Header["kid"].(string)
				if !ok {
					return nil, fmt.Errorf("token has no kid")
				}
				entry, found := set.LookupKeyID(kid)
				if !found {
					return nil, fmt.Errorf("no key %q", kid)
				}
				var raw interface{}
				if err := entry.Raw(&raw); err != nil {
					return nil, err
				}
				return raw, nil
			},
				jwt.WithValidMethods([]string{"RS256", "ES256"}),
				jwt.WithIssuer(fixture.Issuer),
				jwt.WithAudience(fixture.Audience),
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
			scope, _ := payload["scope"].(string)
			if got := strings.Split(scope, " "); !reflect.DeepEqual(got, []string{"tool:acme_kyb:read", "tool:acme_kyb:write"}) {
				t.Fatalf("scope = %v", got)
			}
			act, _ := payload["act"].(map[string]interface{})
			if act["sub"] != "did:grantex:ag_01ORCHESTRATOR" {
				t.Fatalf("act = %v", payload["act"])
			}
			for alias := range LegacyClaimAliases() {
				if _, present := payload[alias]; present {
					t.Fatalf("standard-form token carries legacy alias %s", alias)
				}
			}
		})
	}
}

func TestEveryIssuedTokenVerifiesWithTheSDK(t *testing.T) {
	fixture := loadIssuedTokens(t)
	keys, _ := fixture.JWKS["keys"].([]interface{})
	maps := make([]map[string]interface{}, 0, len(keys))
	for _, key := range keys {
		maps = append(maps, key.(map[string]interface{}))
	}
	server := serveKeys(t, maps...)
	for name, entry := range fixture.Tokens {
		entry := entry
		t.Run(name, func(t *testing.T) {
			grant, err := VerifyGrantToken(context.Background(), entry.Token, VerifyOptions{
				JwksURI: server.URL, Issuer: fixture.Issuer, Audience: fixture.Audience,
				OnLegacyClaim: func(string, string) {},
			})
			if err != nil {
				t.Fatalf("verify: %v", err)
			}
			if grant.AgentDID != "did:grantex:ag_01UNDERWRITER" {
				t.Fatalf("agent = %s", grant.AgentDID)
			}
			if strings.Contains(name, "whitespace") && !reflect.DeepEqual(grant.Scopes, []string{"tool:acme_kyb:read", "read case files"}) {
				t.Fatalf("scopes = %v", grant.Scopes)
			}
		})
	}

	// A whitespace-scope token has no scope claim, so standard-only reading refuses it.
	_, err := VerifyGrantToken(context.Background(), fixture.Tokens["whitespace_scope_es256"].Token, VerifyOptions{
		JwksURI: server.URL, Issuer: fixture.Issuer, StandardClaimsOnly: true,
	})
	if err == nil {
		t.Fatal("expected standard-only reading to refuse a token without scope")
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

func TestVerifyGrantTokenRefusesNullAndMistypedClaims(t *testing.T) {
	fixture := loadGrantTokenFixture(t)
	grant := fixture.Standard[GrantClaim].(map[string]interface{})
	withMember := func(name string, value interface{}) map[string]interface{} {
		copied := map[string]interface{}{}
		for k, v := range grant {
			copied[k] = v
		}
		copied[name] = value
		return copied
	}
	cases := map[string]map[string]interface{}{}
	for _, name := range []string{"scope", "scp", "act", "cnf", "client_id", "aud", "authorization_details", GrantClaim} {
		cases["null "+name] = map[string]interface{}{name: json.RawMessage("null")}
	}
	cases["null grant_id"] = map[string]interface{}{GrantClaim: withMember("grant_id", nil)}
	cases["null delegation_depth"] = map[string]interface{}{GrantClaim: withMember("delegation_depth", nil)}
	cases["numeric client_id"] = map[string]interface{}{"client_id": 7}
	cases["object authorization_details"] = map[string]interface{}{"authorization_details": map[string]interface{}{}}
	for name, extra := range cases {
		extra := extra
		t.Run(name, func(t *testing.T) {
			signed, opts := signFixture(t, fixtureClaims(fixture.Standard, "", nullable(extra)), "at+jwt")
			expectRejected(t, signed, *opts)
		})
	}
}

// nullable turns json.RawMessage("null") placeholders into explicit JSON nulls
// that survive fixtureClaims (which deletes nil values).
func nullable(extra map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for name, value := range extra {
		if raw, ok := value.(json.RawMessage); ok && string(raw) == "null" {
			out[name] = raw
			continue
		}
		out[name] = value
	}
	return out
}

func TestVerifyGrantTokenProofOfPossession(t *testing.T) {
	fixture := loadGrantTokenFixture(t)
	jkt := fixture.Standard["cnf"].(map[string]interface{})["jkt"].(string)

	signed, opts := signFixture(t, fixtureClaims(fixture.Standard, "", nil), "at+jwt")
	bound := *opts
	bound.ProofJKT, bound.RequireProofOfPossession = jkt, true
	if _, err := VerifyGrantToken(context.Background(), signed, bound); err != nil {
		t.Fatalf("matching proof: %v", err)
	}
	wrong := *opts
	wrong.ProofJKT = "another-thumbprint"
	expectRejected(t, signed, wrong)
	missing := *opts
	missing.RequireProofOfPossession = true
	expectRejected(t, signed, missing)
	if grant, err := VerifyGrantToken(context.Background(), signed, *opts); err != nil || grant.Cnf["jkt"] != jkt {
		t.Fatalf("cnf not returned without enforcement: %v %v", grant, err)
	}

	unbound, unboundOpts := signFixture(t, fixtureClaims(fixture.Standard, "", map[string]interface{}{"cnf": nil}), "at+jwt")
	unboundOpts.ProofJKT, unboundOpts.RequireProofOfPossession = jkt, true
	expectRejected(t, unbound, *unboundOpts)
}

func TestVerifyGrantTokenKeepsUnknownActorMembers(t *testing.T) {
	fixture := loadGrantTokenFixture(t)
	act := map[string]interface{}{"sub": "did:grantex:ag_01ORCHESTRATOR", "iss": "https://auth.example.com", "act": map[string]interface{}{"sub": "did:grantex:ag_01INTAKE", "client_id": "ag_01INTAKE"}}
	signed, opts := signFixture(t, fixtureClaims(fixture.Standard, "", map[string]interface{}{"act": act}), "at+jwt")
	grant, err := VerifyGrantToken(context.Background(), signed, *opts)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if grant.Act.Members["iss"] != "https://auth.example.com" || grant.Act.Act.Members["client_id"] != "ag_01INTAKE" {
		t.Fatalf("actor members lost: %+v", grant.Act)
	}
	encoded, err := json.Marshal(grant.Act)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var roundTrip map[string]interface{}
	if err := json.Unmarshal(encoded, &roundTrip); err != nil || !reflect.DeepEqual(roundTrip, act) {
		t.Fatalf("act round trip = %s (%v)", encoded, err)
	}
}
