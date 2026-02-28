package grantex

import (
	"context"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/lestrrat-go/jwx/v2/jwk"
)

// VerifyOptions configures offline grant token verification.
type VerifyOptions struct {
	// JwksURI is the URL to fetch the JSON Web Key Set from.
	JwksURI string

	// RequiredScopes are scopes the token must contain. If empty, scope checking is skipped.
	RequiredScopes []string

	// Audience is the expected audience claim. If empty, audience checking is skipped.
	Audience string

	// ClockTolerance allows for clock skew between servers. Defaults to 0.
	ClockTolerance time.Duration
}

// VerifyGrantToken performs offline JWT verification of a grant token using JWKS.
// It verifies the RS256 signature, expiration, and optionally checks required scopes and audience.
func VerifyGrantToken(ctx context.Context, token string, opts VerifyOptions) (*VerifiedGrant, error) {
	if opts.JwksURI == "" {
		return nil, &TokenError{Message: "jwksUri is required"}
	}

	// Fetch JWKS
	set, err := jwk.Fetch(ctx, opts.JwksURI)
	if err != nil {
		return nil, &TokenError{Message: "failed to fetch JWKS", Cause: err}
	}

	// Parse and verify the JWT
	parserOpts := []jwt.ParserOption{
		jwt.WithValidMethods([]string{"RS256"}),
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

	// Extract standard claims
	grant := &VerifiedGrant{}

	if jti, ok := claims["jti"].(string); ok {
		grant.TokenID = jti
	}
	if sub, ok := claims["sub"].(string); ok {
		grant.PrincipalID = sub
	}
	if agt, ok := claims["agt"].(string); ok {
		grant.AgentDID = agt
	}
	if dev, ok := claims["dev"].(string); ok {
		grant.DeveloperID = dev
	}
	if iat, ok := claims["iat"].(float64); ok {
		grant.IssuedAt = int64(iat)
	}
	if exp, ok := claims["exp"].(float64); ok {
		grant.ExpiresAt = int64(exp)
	}

	// Extract scopes
	if scp, ok := claims["scp"].([]interface{}); ok {
		for _, s := range scp {
			if str, ok := s.(string); ok {
				grant.Scopes = append(grant.Scopes, str)
			}
		}
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
