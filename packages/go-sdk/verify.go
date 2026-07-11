package grantex

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/lestrrat-go/jwx/v2/jwk"
)

const (
	productionJwksURI = "https://api.grantex.dev/.well-known/jwks.json"
	productionIssuer  = "https://grantex.dev"
)

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
}

// VerifyGrantToken performs local JWT verification using JWKS retrieved from JwksURI.
// It verifies the RS256 signature, expiration, issuer, required grant claims,
// and optionally checks required scopes and audience.
func VerifyGrantToken(ctx context.Context, token string, opts VerifyOptions) (*VerifiedGrant, error) {
	jwksURI, expectedIssuer, err := resolveVerificationEndpoints(opts)
	if err != nil {
		return nil, err
	}

	// Fetch JWKS
	set, err := jwk.Fetch(ctx, jwksURI)
	if err != nil {
		return nil, &TokenError{Message: "failed to fetch JWKS", Cause: err}
	}

	// Parse and verify the JWT
	parserOpts := []jwt.ParserOption{
		jwt.WithValidMethods([]string{"RS256"}),
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
			return nil, fmt.Errorf("key %s not found in JWKS", kid)
		}

		var rawKey interface{}
		if err := key.Raw(&rawKey); err != nil {
			return nil, fmt.Errorf("failed to extract raw key: %w", err)
		}
		return rawKey, nil
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
