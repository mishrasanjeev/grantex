package grantex

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"math"
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

// GrantClaim is the claim holding Grantex's grant record fields.
const GrantClaim = "urn:grantex:grant"

// maxActorChainDepth is the longest act chain accepted: the delegation hard cap.
const maxActorChainDepth = 10

// LegacyClaimAliases maps each legacy grant token claim alias to the standard
// claim that replaces it. Reading an alias is deprecated in 0.6 and off by
// default from 0.7.
func LegacyClaimAliases() map[string]string {
	return map[string]string{
		"agt":             GrantClaim + ".agent_did",
		"dev":             GrantClaim + ".developer_id",
		"grnt":            GrantClaim + ".grant_id",
		"scp":             "scope",
		"parentAgt":       "act.sub",
		"parentGrnt":      GrantClaim + ".parent_grant_id",
		"delegationDepth": GrantClaim + ".delegation_depth",
	}
}

var legacyClaimWarned sync.Map

func defaultLegacyClaimWarning(alias, standard string) {
	if _, loaded := legacyClaimWarned.LoadOrStore(alias, true); loaded {
		return
	}
	log.Printf("grantex: DEPRECATED: grant token claim %q is a legacy alias of %s; reading legacy claim aliases stops by default in 0.7 (see docs/migration-0.6.md)", alias, standard)
}

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

	// StandardClaimsOnly stops reading legacy claim aliases (agt, dev, grnt,
	// scp, parentAgt, parentGrnt, delegationDepth) and requires typ at+jwt.
	// False in 0.6, where an alias is read when the standard claim is absent;
	// reading aliases stops by default in 0.7.
	StandardClaimsOnly bool

	// OnLegacyClaim is called for each legacy alias a verification relied on.
	// When nil, a deprecation message is logged once per alias per process.
	OnLegacyClaim func(alias, standard string)

	// ProofJKT is the RFC 7638 thumbprint of the key the caller proved
	// possession of (for example with a verified DPoP proof). When set, the
	// token's cnf.jkt must equal it. The verifier does not check DPoP proofs.
	ProofJKT string

	// RequireProofOfPossession fails closed unless ProofJKT is set and matches
	// cnf.jkt. Without it, a token's cnf is returned but not enforced.
	RequireProofOfPossession bool
}

func checkProofOfPossession(grant *VerifiedGrant, opts VerifyOptions) error {
	if opts.RequireProofOfPossession && opts.ProofJKT == "" {
		return &TokenError{Message: "proof of possession is required but no proof key thumbprint (ProofJKT) was given"}
	}
	if opts.ProofJKT == "" {
		return nil
	}
	jkt, ok := grant.Cnf["jkt"].(string)
	if !ok {
		return &TokenError{Message: "grant token is not key-bound (no cnf.jkt) but proof of possession is required"}
	}
	if subtle.ConstantTimeCompare([]byte(jkt), []byte(opts.ProofJKT)) != 1 {
		return &TokenError{Message: "grant token cnf.jkt does not match the proof key"}
	}
	return nil
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
	if opts.StandardClaimsOnly {
		if typ, _ := parsed.Header["typ"].(string); typ != "at+jwt" {
			return nil, &TokenError{Message: fmt.Sprintf("token typ must be at+jwt, got %q", typ)}
		}
	}

	grant, err := normalizeGrantClaims(claims, !opts.StandardClaimsOnly)
	if err != nil {
		return nil, err
	}
	if err := checkProofOfPossession(grant, opts); err != nil {
		return nil, err
	}
	if len(grant.LegacyClaimsUsed) > 0 {
		warn := opts.OnLegacyClaim
		if warn == nil {
			warn = defaultLegacyClaimWarning
		}
		aliases := LegacyClaimAliases()
		for _, alias := range grant.LegacyClaimsUsed {
			warn(alias, aliases[alias])
		}
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

func claimError(format string, args ...interface{}) error {
	return &TokenError{Message: fmt.Sprintf(format, args...)}
}

func stringClaim(record map[string]interface{}, name, label string) (*string, error) {
	raw, present := record[name]
	if !present {
		return nil, nil
	}
	if raw == nil {
		return nil, claimError("grant token claim %s must not be null", label)
	}
	value, ok := raw.(string)
	if !ok || value == "" {
		return nil, claimError("grant token claim %s must be a non-empty string", label)
	}
	return &value, nil
}

func depthClaim(record map[string]interface{}, name, label string) (*int, error) {
	raw, present := record[name]
	if !present {
		return nil, nil
	}
	if raw == nil {
		return nil, claimError("grant token claim %s must not be null", label)
	}
	number, ok := raw.(float64)
	if !ok || number < 0 || number != math.Trunc(number) || number > float64(math.MaxInt32) {
		return nil, claimError("grant token claim %s must be a non-negative integer", label)
	}
	depth := int(number)
	return &depth, nil
}

func parseActor(raw interface{}) (*ActorClaim, error) {
	var root *ActorClaim
	var parent *ActorClaim
	current := raw
	for depth := 1; ; depth++ {
		record, ok := current.(map[string]interface{})
		sub, subOK := record["sub"].(string)
		if !ok || !subOK || sub == "" {
			return nil, claimError("grant token act claim must be an object with a non-empty string sub")
		}
		actor := &ActorClaim{Sub: sub}
		for member, value := range record {
			if member != "sub" && member != "act" {
				if actor.Members == nil {
					actor.Members = map[string]interface{}{}
				}
				actor.Members[member] = value
			}
		}
		if root == nil {
			root = actor
		} else {
			parent.Act = actor
		}
		parent = actor
		next, present := record["act"]
		if !present {
			return root, nil
		}
		if depth >= maxActorChainDepth {
			return nil, claimError("grant token act chain is deeper than %d", maxActorChainDepth)
		}
		current = next
	}
}

func sameValue(a, b interface{}) bool {
	left, errLeft := json.Marshal(a)
	right, errRight := json.Marshal(b)
	return errLeft == nil && errRight == nil && string(left) == string(right)
}

// normalizeGrantClaims reads grant claims: standard claims first, legacy
// aliases where the standard claim is absent (when legacy is true). A
// standard claim and an alias that disagree are refused.
func normalizeGrantClaims(claims jwt.MapClaims, legacy bool) (*VerifiedGrant, error) {
	// A claim present with a null value is refused, never treated as absent.
	for _, name := range []string{GrantClaim, "scope", "scp", "act", "cnf", "client_id", "aud", "authorization_details"} {
		if raw, present := claims[name]; present && raw == nil {
			return nil, claimError("grant token claim %s must not be null", name)
		}
	}
	var used []string
	aliases := LegacyClaimAliases()
	agree := func(alias string, standard, legacyValue interface{}, standardPresent, legacyPresent bool) (bool, error) {
		if !legacy {
			return false, nil
		}
		if standardPresent && legacyPresent && !sameValue(standard, legacyValue) {
			return false, claimError("grant token claim %s disagrees with its legacy alias %s", aliases[alias], alias)
		}
		if !standardPresent && legacyPresent {
			used = append(used, alias)
			return true, nil
		}
		return false, nil
	}

	grantRecord := map[string]interface{}{}
	if raw, present := claims[GrantClaim]; present && raw != nil {
		record, ok := raw.(map[string]interface{})
		if !ok {
			return nil, claimError("grant token claim %s must be an object", GrantClaim)
		}
		grantRecord = record
	}

	// scope / scp
	var scopes []string
	scopePresent := false
	if raw, present := claims["scope"]; present && raw != nil {
		value, ok := raw.(string)
		if !ok {
			return nil, claimError("grant token claim scope must be a space-delimited string")
		}
		scopePresent = true
		scopes = []string{}
		for _, s := range strings.Split(value, " ") {
			if s != "" {
				scopes = append(scopes, s)
			}
		}
	}
	var scp []string
	scpPresent := false
	if raw, present := claims["scp"]; legacy && present && raw != nil {
		items, ok := raw.([]interface{})
		if !ok {
			return nil, claimError("grant token claim scp must be an array of strings")
		}
		scp = make([]string, 0, len(items))
		for _, item := range items {
			value, ok := item.(string)
			if !ok {
				return nil, claimError("grant token claim scp must be an array of strings")
			}
			scp = append(scp, value)
		}
		scpPresent = true
	}
	_, grantPresent := claims[GrantClaim]
	if legacy && !grantPresent && scpPresent {
		// A pre-0.6 token: scope, when present, is a lossy join of scp.
		scopes, scopePresent = scp, true
		used = append(used, "scp")
	} else if useLegacy, err := agree("scp", scopes, scp, scopePresent, scpPresent); err != nil {
		return nil, err
	} else if useLegacy {
		scopes, scopePresent = scp, true
	}

	pick := func(alias, standardName string, parse func(map[string]interface{}, string, string) (*string, error)) (*string, error) {
		standard, err := parse(grantRecord, standardName, GrantClaim+"."+standardName)
		if err != nil {
			return nil, err
		}
		var legacyValue *string
		if legacy {
			if legacyValue, err = parse(claims, alias, alias); err != nil {
				return nil, err
			}
		}
		var s, l interface{}
		if standard != nil {
			s = *standard
		}
		if legacyValue != nil {
			l = *legacyValue
		}
		useLegacy, err := agree(alias, s, l, standard != nil, legacyValue != nil)
		if err != nil {
			return nil, err
		}
		if useLegacy {
			return legacyValue, nil
		}
		return standard, nil
	}

	agentDID, err := pick("agt", "agent_did", stringClaim)
	if err != nil {
		return nil, err
	}
	developerID, err := pick("dev", "developer_id", stringClaim)
	if err != nil {
		return nil, err
	}
	grantID, err := pick("grnt", "grant_id", stringClaim)
	if err != nil {
		return nil, err
	}
	parentGrantID, err := pick("parentGrnt", "parent_grant_id", stringClaim)
	if err != nil {
		return nil, err
	}

	depth, err := depthClaim(grantRecord, "delegation_depth", GrantClaim+".delegation_depth")
	if err != nil {
		return nil, err
	}
	if legacy {
		legacyDepth, err := depthClaim(claims, "delegationDepth", "delegationDepth")
		if err != nil {
			return nil, err
		}
		var s, l interface{}
		if depth != nil {
			s = *depth
		}
		if legacyDepth != nil {
			l = *legacyDepth
		}
		useLegacy, err := agree("delegationDepth", s, l, depth != nil, legacyDepth != nil)
		if err != nil {
			return nil, err
		}
		if useLegacy {
			depth = legacyDepth
		}
	}

	var act *ActorClaim
	if raw, present := claims["act"]; present && raw != nil {
		if act, err = parseActor(raw); err != nil {
			return nil, err
		}
	}
	var parentAgentDID *string
	if act != nil && (parentGrantID != nil || depth != nil) {
		sub := act.Sub
		parentAgentDID = &sub
	}
	if legacy {
		legacyParent, err := stringClaim(claims, "parentAgt", "parentAgt")
		if err != nil {
			return nil, err
		}
		var s, l interface{}
		if parentAgentDID != nil {
			s = *parentAgentDID
		}
		if legacyParent != nil {
			l = *legacyParent
		}
		useLegacy, err := agree("parentAgt", s, l, parentAgentDID != nil, legacyParent != nil)
		if err != nil {
			return nil, err
		}
		if useLegacy {
			parentAgentDID = legacyParent
		}
	}

	jti, jtiOK := claims["jti"].(string)
	sub, subOK := claims["sub"].(string)
	iat, iatErr := claims.GetIssuedAt()
	exp, expErr := claims.GetExpirationTime()
	if !jtiOK || !subOK || iatErr != nil || iat == nil || expErr != nil || exp == nil ||
		!scopePresent || agentDID == nil || developerID == nil {
		if legacy {
			return nil, &TokenError{Message: "token is missing or has invalid required claims (jti, sub, iat, exp, scope or scp, agent_did or agt, developer_id or dev)"}
		}
		return nil, &TokenError{Message: "token is missing or has invalid required claims (jti, sub, iat, exp, scope, " + GrantClaim + ".agent_did, " + GrantClaim + ".developer_id)"}
	}

	grant := &VerifiedGrant{
		TokenID:          jti,
		GrantID:          jti,
		PrincipalID:      sub,
		AgentDID:         *agentDID,
		DeveloperID:      *developerID,
		Scopes:           scopes,
		IssuedAt:         iat.Unix(),
		ExpiresAt:        exp.Unix(),
		ParentAgentDID:   parentAgentDID,
		ParentGrantID:    parentGrantID,
		DelegationDepth:  depth,
		Act:              act,
		LegacyClaimsUsed: used,
	}
	if grantID != nil {
		grant.GrantID = *grantID
	}
	if raw, present := claims["client_id"]; present {
		clientID, ok := raw.(string)
		if !ok || clientID == "" {
			return nil, claimError("grant token claim client_id must be a non-empty string")
		}
		grant.ClientID = &clientID
	}
	if raw, present := claims["cnf"]; present && raw != nil {
		cnf, ok := raw.(map[string]interface{})
		if !ok {
			return nil, claimError("grant token claim cnf must be an object")
		}
		grant.Cnf = cnf
	}
	if raw, present := claims["authorization_details"]; present {
		details, ok := raw.([]interface{})
		if !ok {
			return nil, claimError("grant token claim authorization_details must be an array")
		}
		grant.AuthorizationDetails = details
	}
	if _, present := claims["aud"]; present {
		audience, err := claims.GetAudience()
		if err != nil {
			return nil, claimError("grant token claim aud must be a string or an array of strings")
		}
		grant.Audience = []string(audience)
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
