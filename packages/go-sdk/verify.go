package grantex

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/lestrrat-go/jwx/v2/jwk"
)

// grantTokenAlgorithms are the signature algorithms a grant token may use.
// Each maps to one key type: RS256 to an RSA key, ES256 to an EC key on P-256.
// "none", the HMAC family and every other algorithm are refused.
var grantTokenAlgorithms = []string{"RS256", "ES256"}

// GrantTokenAlgorithms returns the signature algorithms VerifyGrantToken
// accepts by default: RS256 and ES256.
func GrantTokenAlgorithms() []string {
	return append([]string(nil), grantTokenAlgorithms...)
}

const (
	productionJwksURI = "https://api.grantex.dev/.well-known/jwks.json"
	productionIssuer  = "https://grantex.dev"

	// jwksMinRefreshInterval bounds how often the background cache re-fetches
	// a key set when the issuer sends no cache headers.
	jwksMinRefreshInterval = 10 * time.Minute
	// jwksUnknownKidCooldown bounds how often an unknown kid may force an
	// out-of-band refresh, so a flood of forged kids cannot become a flood of
	// requests against the issuer.
	jwksUnknownKidCooldown = 30 * time.Second
)

// A process-wide jwk.Cache replaces the per-call jwk.Fetch: every
// verification used to download the key set again, which is both slow and a
// way for a request flood to hammer the issuer. Registered URLs are refreshed
// in the background; an unknown kid (key rotation) triggers one immediate
// refresh subject to jwksUnknownKidCooldown.
var (
	jwksCacheOnce sync.Once
	jwksCache     *jwk.Cache

	jwksRefreshMu   sync.Mutex
	jwksLastRefresh = map[string]time.Time{}
)

func getJwksCache() *jwk.Cache {
	jwksCacheOnce.Do(func() {
		jwksCache = jwk.NewCache(context.Background())
	})
	return jwksCache
}

// fetchJwks returns the cached key set for jwksURI, registering and fetching
// it on first use.
func fetchJwks(ctx context.Context, jwksURI string) (jwk.Set, error) {
	cache := getJwksCache()
	jwksRefreshMu.Lock()
	if !cache.IsRegistered(jwksURI) {
		if err := cache.Register(jwksURI, jwk.WithMinRefreshInterval(jwksMinRefreshInterval)); err != nil {
			jwksRefreshMu.Unlock()
			return nil, err
		}
		jwksLastRefresh[jwksURI] = time.Now()
	}
	jwksRefreshMu.Unlock()
	return cache.Get(ctx, jwksURI)
}

// refreshJwksForUnknownKid re-fetches jwksURI once per cooldown window.
// It returns (nil, false) when the cooldown has not elapsed.
func refreshJwksForUnknownKid(ctx context.Context, jwksURI string) (jwk.Set, bool) {
	jwksRefreshMu.Lock()
	if time.Since(jwksLastRefresh[jwksURI]) < jwksUnknownKidCooldown {
		jwksRefreshMu.Unlock()
		return nil, false
	}
	jwksLastRefresh[jwksURI] = time.Now()
	jwksRefreshMu.Unlock()

	set, err := getJwksCache().Refresh(ctx, jwksURI)
	if err != nil {
		return nil, false
	}
	return set, true
}

// VerifyOptions configures local grant token verification using remotely retrieved JWKS.
type VerifyOptions struct {
	// JwksURI is the URL to fetch the JSON Web Key Set from.
	JwksURI string

	// Issuer is the expected issuer claim. When empty, it is derived from
	// IssuerDID or JwksURI. The hosted Grantex JWKS maps to https://grantex.dev.
	Issuer string

	// IssuerDID resolves a did:web identifier to its JWKS URL and issuer.
	// It takes precedence over JwksURI when set to a did:web value.
	IssuerDID string

	// RequiredScopes are scopes the token must contain. If empty, scope checking is skipped.
	RequiredScopes []string

	// Audience is the expected audience claim. If empty, audience checking is skipped.
	Audience string

	// ClockTolerance allows for clock skew between servers. Defaults to 0.
	ClockTolerance time.Duration

	// Algorithms narrows the accepted signature algorithms to a subset of
	// GrantTokenAlgorithms (RS256 and ES256, the default when empty). Any
	// other value is rejected.
	Algorithms []string
}

func resolveAlgorithms(requested []string) ([]string, error) {
	if len(requested) == 0 {
		return GrantTokenAlgorithms(), nil
	}
	allowed := make([]string, 0, len(requested))
	seen := make(map[string]bool, len(requested))
	for _, alg := range requested {
		supported := false
		for _, candidate := range grantTokenAlgorithms {
			if alg == candidate {
				supported = true
				break
			}
		}
		if !supported {
			return nil, &TokenError{Message: fmt.Sprintf("unsupported grant token algorithm %q; allowed: %s", alg, strings.Join(grantTokenAlgorithms, ", "))}
		}
		if !seen[alg] {
			seen[alg] = true
			allowed = append(allowed, alg)
		}
	}
	return allowed, nil
}

// publicKeyForAlgorithm returns the raw public key of a JWK Set entry for alg.
// The entry must be of the key type (and curve) alg requires, must not be
// published for a different algorithm or for a use other than "sig", and
// must be a public key.
func publicKeyForAlgorithm(key jwk.Key, alg string) (interface{}, error) {
	if published := key.Algorithm().String(); published != "" && published != alg {
		return nil, fmt.Errorf("key %s is published for %s, not %s", key.KeyID(), published, alg)
	}
	if use := key.KeyUsage(); use != "" && use != "sig" {
		return nil, fmt.Errorf("key %s has use %q, not sig", key.KeyID(), use)
	}

	var rawKey interface{}
	if err := key.Raw(&rawKey); err != nil {
		return nil, fmt.Errorf("failed to extract raw key: %w", err)
	}
	switch alg {
	case "RS256":
		pub, ok := rawKey.(*rsa.PublicKey)
		if !ok {
			return nil, fmt.Errorf("RS256 requires an RSA public key; key %s is %T", key.KeyID(), rawKey)
		}
		return pub, nil
	case "ES256":
		pub, ok := rawKey.(*ecdsa.PublicKey)
		if !ok {
			return nil, fmt.Errorf("ES256 requires an EC public key; key %s is %T", key.KeyID(), rawKey)
		}
		if pub.Curve != elliptic.P256() {
			return nil, fmt.Errorf("ES256 requires curve P-256; key %s is on %s", key.KeyID(), pub.Curve.Params().Name)
		}
		return pub, nil
	default:
		return nil, fmt.Errorf("unsupported algorithm %s", alg)
	}
}

// VerifyGrantToken performs local JWT verification using JWKS retrieved from JwksURI.
// It verifies the RS256 or ES256 signature, expiration, issuer, required grant
// claims, and optionally checks required scopes and audience. The key is the
// JWK Set entry named by the token's kid, of the key type its algorithm
// requires.
func VerifyGrantToken(ctx context.Context, token string, opts VerifyOptions) (*VerifiedGrant, error) {
	algorithms, err := resolveAlgorithms(opts.Algorithms)
	if err != nil {
		return nil, err
	}
	jwksURI, expectedIssuer, err := resolveVerificationEndpoints(opts)
	if err != nil {
		return nil, err
	}

	// Fetch JWKS (cached; see fetchJwks)
	set, err := fetchJwks(ctx, jwksURI)
	if err != nil {
		return nil, &TokenError{Message: "failed to fetch JWKS", Cause: err}
	}

	// Parse and verify the JWT
	parserOpts := []jwt.ParserOption{
		jwt.WithValidMethods(algorithms),
		jwt.WithIssuer(expectedIssuer),
		jwt.WithExpirationRequired(),
	}
	if opts.ClockTolerance > 0 {
		parserOpts = append(parserOpts, jwt.WithLeeway(opts.ClockTolerance))
	}
	if opts.Audience != "" {
		parserOpts = append(parserOpts, jwt.WithAudience(opts.Audience))
	}

	parsed, err := jwt.Parse(token, func(t *jwt.Token) (interface{}, error) {
		kid, ok := t.Header["kid"].(string)
		if !ok {
			return nil, fmt.Errorf("missing kid header")
		}

		key, found := set.LookupKeyID(kid)
		if !found {
			// The issuer may have rotated keys since the cached fetch.
			if refreshed, ok := refreshJwksForUnknownKid(ctx, jwksURI); ok {
				key, found = refreshed.LookupKeyID(kid)
			}
		}
		if !found {
			return nil, fmt.Errorf("key %s not found in JWKS", kid)
		}

		// WithValidMethods has already limited the algorithm; the key must
		// also be of the type that algorithm requires.
		return publicKeyForAlgorithm(key, t.Method.Alg())
	}, parserOpts...)

	if err != nil {
		return nil, &TokenError{Message: "token verification failed", Cause: err}
	}

	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return nil, &TokenError{Message: "invalid token claims"}
	}

	// Validate and extract the core Grantex claims. A signed token with a
	// malformed payload must not be treated as a partially populated grant.
	jti, jtiOK := claims["jti"].(string)
	sub, subOK := claims["sub"].(string)
	agt, agtOK := claims["agt"].(string)
	dev, devOK := claims["dev"].(string)
	scp, scpOK := claims["scp"].([]interface{})
	iat, iatErr := claims.GetIssuedAt()
	exp, expErr := claims.GetExpirationTime()
	if !jtiOK || !subOK || !agtOK || !devOK || !scpOK ||
		iatErr != nil || iat == nil || expErr != nil || exp == nil {
		return nil, &TokenError{Message: "token is missing or has invalid required claims (jti, sub, agt, dev, scp, iat, exp)"}
	}

	scopes := make([]string, 0, len(scp))
	for _, scope := range scp {
		value, ok := scope.(string)
		if !ok {
			return nil, &TokenError{Message: "token is missing or has invalid required claims (jti, sub, agt, dev, scp, iat, exp)"}
		}
		scopes = append(scopes, value)
	}

	grant := &VerifiedGrant{
		TokenID:     jti,
		PrincipalID: sub,
		AgentDID:    agt,
		DeveloperID: dev,
		Scopes:      scopes,
		IssuedAt:    iat.Unix(),
		ExpiresAt:   exp.Unix(),
	}
	if clientID, ok := claims["client_id"].(string); ok {
		grant.ClientID = &clientID
	}

	// Grant ID (falls back to jti)
	if grnt, ok := claims["grnt"].(string); ok {
		grant.GrantID = grnt
	} else {
		grant.GrantID = grant.TokenID
	}

	// Delegation claims
	if parentAgt, ok := claims["parentAgt"].(string); ok {
		grant.ParentAgentDID = &parentAgt
	}
	if parentGrnt, ok := claims["parentGrnt"].(string); ok {
		grant.ParentGrantID = &parentGrnt
	}
	if depth, ok := claims["delegationDepth"].(float64); ok {
		d := int(depth)
		grant.DelegationDepth = &d
	}

	// Check required scopes
	if len(opts.RequiredScopes) > 0 {
		scopeSet := make(map[string]bool, len(grant.Scopes))
		for _, s := range grant.Scopes {
			scopeSet[s] = true
		}
		for _, required := range opts.RequiredScopes {
			if !scopeSet[required] {
				return nil, &TokenError{Message: fmt.Sprintf("missing required scope: %s", required)}
			}
		}
	}

	return grant, nil
}

func resolveVerificationEndpoints(opts VerifyOptions) (string, string, error) {
	jwksURI := opts.JwksURI
	expectedIssuer := opts.Issuer

	if strings.HasPrefix(opts.IssuerDID, "did:web:") {
		domain := strings.ReplaceAll(strings.TrimPrefix(opts.IssuerDID, "did:web:"), ":", "/")
		if domain == "" {
			return "", "", &TokenError{Message: "issuerDid must contain a did:web identifier"}
		}
		jwksURI = "https://" + domain + "/.well-known/jwks.json"
		if expectedIssuer == "" {
			expectedIssuer = "https://" + domain
		}
	}

	if jwksURI == "" {
		return "", "", &TokenError{Message: "jwksUri is required"}
	}
	if expectedIssuer == "" {
		var err error
		expectedIssuer, err = deriveIssuerFromJwksURI(jwksURI)
		if err != nil {
			return "", "", &TokenError{Message: "invalid jwksUri", Cause: err}
		}
	}

	return jwksURI, expectedIssuer, nil
}

func deriveIssuerFromJwksURI(jwksURI string) (string, error) {
	if strings.TrimRight(jwksURI, "/") == productionJwksURI {
		return productionIssuer, nil
	}

	parsed, err := url.Parse(jwksURI)
	if err != nil {
		return "", err
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("JWKS URL must include a scheme and host")
	}

	path := parsed.Path
	const wellKnownSuffix = "/.well-known/jwks.json"
	if strings.HasSuffix(path, wellKnownSuffix) {
		path = strings.TrimSuffix(path, wellKnownSuffix)
	} else {
		path = strings.TrimRight(path, "/")
	}

	return parsed.Scheme + "://" + parsed.Host + path, nil
}
