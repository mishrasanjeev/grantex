package grantex

// Relying-party verification of OACP artifacts (profile oacp-artifact-jws-v1).
//
// An OACP artifact is an envelope and a payload. The envelope carries
// payload_hash, the lowercase hex SHA-256 of the RFC 8785 canonical payload,
// and signature, a detached compact JWS (RFC 7515 Appendix F) whose protected
// header is exactly {"alg":"ES256","kid":<issuer_key_id>,"typ":"oacp-artifact+jws"}
// and whose payload is the RFC 8785 canonical envelope without signature.
// Signing the whole envelope binds the scope, expiry, status entry and safety
// block as well as the payload hash.
//
// VerifyOacpArtifact runs the checks in a fixed order and stops at the first
// failure, so every implementation (the TypeScript and Python SDKs, this SDK
// and the auth service) refuses a given artifact with the same code:
//
//  1. signature is a detached JWS: three base64url parts, empty middle
//     (signature_missing_or_placeholder);
//  2. signature_alg is ES256 (signature_algorithm_unsupported);
//  3. the payload hashes to payload_hash (payload_hash_mismatch);
//  4. the header is exactly alg/kid/typ with ES256, oacp-artifact+jws and
//     kid == issuer_key_id (detached_jws_verification_failed);
//  5. the envelope names the pinned issuer and the JWK Set holds exactly one
//     usable P-256 key with that kid (issuer_key_untrusted);
//  6. the ES256 signature verifies (detached_jws_verification_failed);
//  7. artifact type, safety block, private fields, timestamps, TTL and scope
//     (artifact_missing_or_invalid, artifact_not_yet_valid,
//     artifact_expired_or_stale, artifact_ttl_exceeds_default,
//     artifact_scope_mismatch);
//  8. the Token Status List entry is VALID (artifact_revoked,
//     artifact_suspended, or revocation_status_unavailable when the list
//     cannot be fetched or verified: fail closed).
//
// Shared test vectors: spec/examples/oacp/oacp-artifact-jws-v1.json.

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// OacpArtifactJWSTyp is the typ of an OACP artifact's protected header.
	OacpArtifactJWSTyp = "oacp-artifact+jws"
	// OacpSignatureAlg is the one signature algorithm of the profile.
	OacpSignatureAlg = "ES256"
	// OacpProfile names the artifact signature profile.
	OacpProfile = "oacp-artifact-jws-v1"
)

// oacpMaxSignatureLength is the longest signature accepted, in UTF-16 code
// units (the unit the other SDKs count in).
const oacpMaxSignatureLength = 4096

// OacpRefusalCode says why VerifyOacpArtifact refused an artifact.
type OacpRefusalCode string

// Every refusal code VerifyOacpArtifact returns, in check order.
const (
	OacpArtifactMissingOrInvalid      OacpRefusalCode = "artifact_missing_or_invalid"
	OacpSignatureMissingOrPlaceholder OacpRefusalCode = "signature_missing_or_placeholder"
	OacpSignatureAlgorithmUnsupported OacpRefusalCode = "signature_algorithm_unsupported"
	OacpPayloadHashMismatch           OacpRefusalCode = "payload_hash_mismatch"
	OacpDetachedJWSVerificationFailed OacpRefusalCode = "detached_jws_verification_failed"
	OacpIssuerKeyUntrusted            OacpRefusalCode = "issuer_key_untrusted"
	OacpArtifactNotYetValid           OacpRefusalCode = "artifact_not_yet_valid"
	OacpArtifactExpiredOrStale        OacpRefusalCode = "artifact_expired_or_stale"
	OacpArtifactTTLExceedsDefault     OacpRefusalCode = "artifact_ttl_exceeds_default"
	OacpArtifactScopeMismatch         OacpRefusalCode = "artifact_scope_mismatch"
	OacpArtifactRevoked               OacpRefusalCode = "artifact_revoked"
	OacpArtifactSuspended             OacpRefusalCode = "artifact_suspended"
	OacpRevocationStatusUnavailable   OacpRefusalCode = "revocation_status_unavailable"
)

// OacpRefusalCodes returns every refusal code VerifyOacpArtifact returns, in
// check order.
func OacpRefusalCodes() []OacpRefusalCode {
	return []OacpRefusalCode{
		OacpArtifactMissingOrInvalid,
		OacpSignatureMissingOrPlaceholder,
		OacpSignatureAlgorithmUnsupported,
		OacpPayloadHashMismatch,
		OacpDetachedJWSVerificationFailed,
		OacpIssuerKeyUntrusted,
		OacpArtifactNotYetValid,
		OacpArtifactExpiredOrStale,
		OacpArtifactTTLExceedsDefault,
		OacpArtifactScopeMismatch,
		OacpArtifactRevoked,
		OacpArtifactSuspended,
		OacpRevocationStatusUnavailable,
	}
}

// Values of OacpVerification.Status.
const (
	// OacpVerificationStatusValid: the Token Status List entry is VALID.
	OacpVerificationStatusValid = "valid"
	// OacpVerificationStatusNotChecked: SkipStatusCheck was set.
	OacpVerificationStatusNotChecked = "not_checked"
)

var oacpArtifactMaxTTLSeconds = map[string]int64{
	"merchant_capability":     24 * 60 * 60,
	"seller_agent_capability": 6 * 60 * 60,
	"catalog_snapshot":        6 * 60 * 60,
	"offer":                   15 * 60,
	"price":                   5 * 60,
	"inventory":               60,
	"policy":                  6 * 60 * 60,
	"public_discovery":        15 * 60,
	"mandate_capability":      2 * 60,
	"commitment_evidence":     5 * 60,
	"revocation":              24 * 60 * 60,
	"protocol_adapter":        24 * 60 * 60,
}

// OacpArtifactMaxTTLSeconds returns a copy of the longest lifetime
// (expires_at - issued_at) each artifact type may have, in seconds, as the
// auth service pins them.
func OacpArtifactMaxTTLSeconds() map[string]int64 {
	out := make(map[string]int64, len(oacpArtifactMaxTTLSeconds))
	for k, v := range oacpArtifactMaxTTLSeconds {
		out[k] = v
	}
	return out
}

var oacpForbiddenPayloadFields = map[string]struct{}{
	"access_token": {}, "api_key": {}, "authorization": {}, "bank_account": {}, "card_number": {},
	"checkout_payment_enabled": {}, "credential": {}, "credentials": {}, "customer_identifier": {},
	"live_payment_enabled": {}, "live_provider_enabled": {}, "merchant_private_api_key": {},
	"merchant_private_api_url": {}, "password": {}, "private_key": {}, "production_allowlist": {},
	"public_discovery_enabled": {}, "raw_connector_payload": {}, "raw_jwt": {},
	"raw_provider_payload": {}, "secret": {}, "token": {}, "webhook_secret": {},
}

// OacpForbiddenPayloadFields returns, sorted, the payload member names that
// would carry private or enabling data. Member names are compared after
// folding camelCase, hyphens and spaces to snake_case.
func OacpForbiddenPayloadFields() []string {
	out := make([]string, 0, len(oacpForbiddenPayloadFields))
	for k := range oacpForbiddenPayloadFields {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// OacpArtifactScope is the scope an artifact is expected to be bound to. A
// nil member is not compared; a non-nil member, even "", must equal the
// envelope's.
type OacpArtifactScope struct {
	TenantID      *string
	MerchantID    *string
	SellerAgentID *string
	BuyerAgentID  *string
}

// OacpVerifyOptions configures VerifyOacpArtifact.
type OacpVerifyOptions struct {
	// Issuer is the pinned issuer identifier; envelope.issuer must equal it.
	Issuer string
	// JWKS is the issuer's JWK Set, used when JWKSFetcher is nil.
	JWKS json.RawMessage
	// JWKSFetcher returns the issuer's JWK Set (NewOacpJWKSFetcher); refresh
	// asks for a fresh copy after a kid was not found. It takes precedence
	// over JWKS.
	JWKSFetcher func(ctx context.Context, refresh bool) (json.RawMessage, error)
	// Now is the time to verify at. The zero value means time.Now().
	Now time.Time
	// ExpectedScope refuses an artifact outside this scope
	// (artifact_scope_mismatch).
	ExpectedScope *OacpArtifactScope
	// StatusListFetcher fetches the Token Status List the envelope points at
	// (NewOacpStatusListFetcher(...).Fetch). Without one the artifact is
	// refused with revocation_status_unavailable unless SkipStatusCheck is
	// set.
	StatusListFetcher func(ctx context.Context, uri string) (string, error)
	// SkipStatusCheck verifies signatures offline only (test vectors,
	// archives); the result's Status is then "not_checked". The zero value
	// checks the status list and fails closed.
	SkipStatusCheck bool
	// MaxTTLSeconds overrides OacpArtifactMaxTTLSeconds per artifact type.
	MaxTTLSeconds map[string]int64
	// AllowLoopbackHTTP accepts an http status URI on a loopback host (local
	// development only).
	AllowLoopbackHTTP bool
}

// OacpVerification is the outcome of VerifyOacpArtifact. When Valid is
// false, RefusalCode and Message say why and ArtifactID is set when the
// envelope names one; the other fields are set only for a valid artifact.
type OacpVerification struct {
	Valid        bool
	RefusalCode  OacpRefusalCode
	Message      string
	ArtifactID   string
	ArtifactType string
	IssuerKeyID  string
	PayloadHash  string
	ExpiresAt    string
	// Status is "valid" after a Token Status List check and "not_checked"
	// when SkipStatusCheck was set.
	Status string
}

// ---- parsed JSON helpers ----

func oacpAsObject(v any) (*oacpObject, bool) {
	o, ok := v.(*oacpObject)
	return o, ok && o != nil
}

// oacpString returns the member as a string, and false when it is absent or
// not a string.
func oacpString(o *oacpObject, key string) (string, bool) {
	v, ok := o.get(key)
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

// oacpBool reports whether the member is the JSON literal want.
func oacpBool(o *oacpObject, key string, want bool) bool {
	v, ok := o.get(key)
	if !ok {
		return false
	}
	b, ok := v.(bool)
	return ok && b == want
}

const oacpMaxSafeInteger = 1<<53 - 1

// oacpSafeInteger mirrors Number.isSafeInteger for a parsed JSON value.
func oacpSafeInteger(v any) (int64, bool) {
	n, ok := v.(oacpNumber)
	if !ok || math.IsInf(n.value, 0) || math.IsNaN(n.value) || n.value != math.Trunc(n.value) {
		return 0, false
	}
	if math.Abs(n.value) > oacpMaxSafeInteger {
		return 0, false
	}
	return int64(n.value), true
}

func oacpUTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// ---- JOSE ----

// oacpIsBase64urlShaped reports whether value uses only base64url
// characters and has a length base64url can produce.
func oacpIsBase64urlShaped(value string) bool {
	if len(value)%4 == 1 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// oacpDecodeBase64urlStrict decodes unpadded base64url, refusing any text
// that is not the one canonical encoding of its bytes.
func oacpDecodeBase64urlStrict(value string) ([]byte, bool) {
	if !oacpIsBase64urlShaped(value) {
		return nil, false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(b) != value {
		return nil, false
	}
	return b, true
}

// oacpDecodeJSONSegment decodes a JOSE header or claims set: a base64url
// UTF-8 JSON object without repeated member names.
func oacpDecodeJSONSegment(segment string) (*oacpObject, bool) {
	b, ok := oacpDecodeBase64urlStrict(segment)
	if !ok || !utf8.Valid(b) {
		return nil, false
	}
	// A UTF-8 decoder strips a leading byte order mark, as TextDecoder does.
	b = bytes.TrimPrefix(b, []byte("\xEF\xBB\xBF"))
	v, err := parseOacpJSON(b, false)
	if err != nil {
		return nil, false
	}
	return oacpAsObject(v)
}

// oacpKey is a verification key selected from a JWK Set.
type oacpKey struct {
	ec  *ecdsa.PublicKey
	rsa *rsa.PublicKey
}

var oacpKeyType = map[string]string{"ES256": "EC", "RS256": "RSA"}

// selectOacpVerificationKey returns the one key in jwks with kid, usable for
// alg: use absent or "sig", alg absent or equal, kty matching the algorithm,
// P-256 with 32-byte coordinates for ES256, a modulus of at least 2048 bits
// for RS256, and no private members. Otherwise it returns the reason.
func selectOacpVerificationKey(jwks any, kid, alg string) (oacpKey, string) {
	set, ok := oacpAsObject(jwks)
	if !ok {
		return oacpKey{}, "the JWK Set has no keys array"
	}
	rawKeys, _ := set.get("keys")
	keys, ok := rawKeys.([]any)
	if !ok {
		return oacpKey{}, "the JWK Set has no keys array"
	}
	var matches []*oacpObject
	for _, k := range keys {
		if o, ok := oacpAsObject(k); ok {
			if id, ok := oacpString(o, "kid"); ok && id == kid {
				matches = append(matches, o)
			}
		}
	}
	if len(matches) == 0 {
		return oacpKey{}, fmt.Sprintf("no key with kid %q", kid)
	}
	if len(matches) > 1 {
		return oacpKey{}, fmt.Sprintf("several keys with kid %q", kid)
	}
	jwk := matches[0]
	if _, present := jwk.get("use"); present {
		if use, ok := oacpString(jwk, "use"); !ok || use != "sig" {
			return oacpKey{}, "the key is not a signing key"
		}
	}
	if _, present := jwk.get("alg"); present {
		if a, ok := oacpString(jwk, "alg"); !ok || a != alg {
			return oacpKey{}, "the key is not for " + alg
		}
	}
	if kty, ok := oacpString(jwk, "kty"); !ok || kty != oacpKeyType[alg] {
		return oacpKey{}, "the key type is not " + oacpKeyType[alg]
	}
	_, hasD := jwk.get("d")
	_, hasP := jwk.get("p")
	if hasD || hasP {
		return oacpKey{}, "the JWK Set publishes private key material"
	}
	coord := func(name string) ([]byte, bool) {
		s, ok := oacpString(jwk, name)
		if !ok {
			return nil, false
		}
		return oacpDecodeBase64urlStrict(s)
	}
	if alg == "ES256" {
		if crv, ok := oacpString(jwk, "crv"); !ok || crv != "P-256" {
			return oacpKey{}, "the key is not on P-256"
		}
		x, okX := coord("x")
		y, okY := coord("y")
		if !okX || !okY || len(x) != 32 || len(y) != 32 {
			return oacpKey{}, "the key coordinates are not 32 bytes"
		}
		point := make([]byte, 0, 65)
		point = append(point, 0x04)
		point = append(point, x...)
		point = append(point, y...)
		pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), point)
		if err != nil {
			return oacpKey{}, "the key cannot be imported"
		}
		return oacpKey{ec: pub}, ""
	}
	n, okN := coord("n")
	e, okE := coord("e")
	if !okN || !okE || len(n) < 256 {
		return oacpKey{}, "the RSA key is malformed or shorter than 2048 bits"
	}
	exp := new(big.Int).SetBytes(e)
	if exp.Sign() <= 0 || !exp.IsInt64() || exp.Int64() > math.MaxInt32 {
		return oacpKey{}, "the key cannot be imported"
	}
	return oacpKey{rsa: &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(exp.Int64())}}, ""
}

// verifyOacpJWSSignature checks a JWS signature over the ASCII signing
// input: ES256 as IEEE P1363 r||s, RS256 as RSASSA-PKCS1-v1_5.
func verifyOacpJWSSignature(alg string, key oacpKey, signingInput string, signature []byte) bool {
	digest := sha256.Sum256([]byte(signingInput))
	switch alg {
	case "ES256":
		if key.ec == nil || len(signature) != 64 {
			return false
		}
		r := new(big.Int).SetBytes(signature[:32])
		s := new(big.Int).SetBytes(signature[32:])
		return ecdsa.Verify(key.ec, digest[:], r, s)
	case "RS256":
		if key.rsa == nil {
			return false
		}
		return rsa.VerifyPKCS1v15(key.rsa, crypto.SHA256, digest[:], signature) == nil
	}
	return false
}

// ---- timestamps ----

var oacpRFC3339 = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$`)

// ParseOacpTimestamp parses an RFC 3339 date-time the way the OACP verifiers
// do, returning milliseconds since the Unix epoch. Fractions beyond
// milliseconds are truncated; an impossible date (such as February 30) or
// offset is refused.
func ParseOacpTimestamp(value string) (int64, bool) {
	m := oacpRFC3339.FindStringSubmatch(value)
	if m == nil {
		return 0, false
	}
	num := func(s string) int {
		n, _ := strconv.Atoi(s)
		return n
	}
	y, month, day, h, mi, s := num(m[1]), num(m[2]), num(m[3]), num(m[4]), num(m[5]), num(m[6])
	if month < 1 || month > 12 || day < 1 || day > 31 || h > 23 || mi > 59 || s > 59 {
		return 0, false
	}
	// Date.UTC reads a year from 0 to 99 as 1900 to 1999; the shared
	// semantics keep that.
	if y <= 99 {
		y += 1900
	}
	t := time.Date(y, time.Month(month), day, h, mi, s, 0, time.UTC)
	if t.Day() != day {
		return 0, false
	}
	millis := t.UnixMilli()
	if frac := m[7]; frac != "" {
		f, err := strconv.ParseFloat("0"+frac, 64)
		if err != nil {
			return 0, false
		}
		millis += int64(math.Floor(f * 1000))
	}
	if zone := m[8]; zone != "Z" {
		sign := int64(1)
		if zone[0] == '-' {
			sign = -1
		}
		zh, zm := num(zone[1:3]), num(zone[4:6])
		if zh > 23 || zm > 59 {
			return 0, false
		}
		millis -= sign * int64(zh*60+zm) * 60_000
	}
	return millis, true
}

// oacpTimestamp parses a member as a timestamp; absent or non-string members
// are invalid.
func oacpTimestamp(v any) (int64, bool) {
	s, ok := v.(string)
	if !ok {
		return 0, false
	}
	return ParseOacpTimestamp(s)
}

// ---- private fields ----

// oacpIsJSSpace reports the characters JavaScript's \s and String.trim treat
// as white space.
func oacpIsJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0xFEFF, 0x2028, 0x2029:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// oacpTrimJS trims as String.prototype.trim does.
func oacpTrimJS(s string) string {
	return strings.TrimFunc(s, oacpIsJSSpace)
}

// oacpNormalizeKey folds camelCase, hyphens and white space to snake_case
// and lowercases, as the other SDKs do.
func oacpNormalizeKey(key string) string {
	var b strings.Builder
	isLowerOrDigit := func(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') }
	for i := 0; i < len(key); {
		if i+1 < len(key) && isLowerOrDigit(key[i]) && key[i+1] >= 'A' && key[i+1] <= 'Z' {
			b.WriteByte(key[i])
			b.WriteByte('_')
			b.WriteByte(key[i+1])
			i += 2
			continue
		}
		b.WriteByte(key[i])
		i++
	}
	var out strings.Builder
	inRun := false
	for _, r := range b.String() {
		if r == '-' || oacpIsJSSpace(r) {
			if !inRun {
				out.WriteByte('_')
				inRun = true
			}
			continue
		}
		inRun = false
		// String.prototype.toLowerCase maps U+0130 to "i" + U+0307.
		if r == 0x0130 {
			out.WriteString("i̇")
			continue
		}
		out.WriteRune(unicode.ToLower(r))
	}
	return out.String()
}

func oacpHasForbiddenField(value any) bool {
	stack := []any{value}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		switch t := current.(type) {
		case []any:
			stack = append(stack, t...)
		case *oacpObject:
			for _, k := range t.keys {
				if _, bad := oacpForbiddenPayloadFields[oacpNormalizeKey(k)]; bad {
					return true
				}
				stack = append(stack, t.members[k])
			}
		}
	}
	return false
}

// ---- status URI ----

// oacpIsLoopbackHost reports localhost, 127.0.0.0/8 or ::1.
func oacpIsLoopbackHost(hostname string) bool {
	host := strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(hostname, "["), "]"))
	if host == "localhost" || host == "::1" {
		return true
	}
	parts := strings.Split(host, ".")
	if len(parts) != 4 || parts[0] != "127" {
		return false
	}
	for _, p := range parts[1:] {
		if len(p) < 1 || len(p) > 3 {
			return false
		}
		for i := 0; i < len(p); i++ {
			if p[i] < '0' || p[i] > '9' {
				return false
			}
		}
	}
	return true
}

// oacpParseHTTPURL parses an absolute http(s) URL with a host.
func oacpParseHTTPURL(raw string) (*url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.Host == "" {
		return nil, false
	}
	u.Scheme = strings.ToLower(u.Scheme)
	return u, true
}

func oacpStatusURIAllowed(uri string, allowLoopbackHTTP bool) bool {
	u, ok := oacpParseHTTPURL(uri)
	if !ok {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	return allowLoopbackHTTP && u.Scheme == "http" && oacpIsLoopbackHost(u.Hostname())
}

// ---- the verifier ----

func oacpLoadJWKS(ctx context.Context, opts *OacpVerifyOptions, refresh bool) (any, error) {
	if opts.JWKSFetcher == nil {
		v, err := parseOacpJSON(opts.JWKS, true)
		if err != nil {
			return nil, nil // no usable set; key selection says why
		}
		return v, nil
	}
	raw, err := opts.JWKSFetcher(ctx, refresh)
	if err != nil {
		return nil, err
	}
	return parseOacpJSON(raw, true)
}

// VerifyOacpArtifact verifies an OACP artifact, given the envelope and the
// payload as JSON texts. It never panics or returns an error for a bad
// artifact: the result says why it is refused.
func VerifyOacpArtifact(ctx context.Context, envelope, payload json.RawMessage, opts OacpVerifyOptions) OacpVerification {
	if ctx == nil {
		ctx = context.Background()
	}
	envValue, envErr := parseOacpJSON(envelope, false)
	env, envOK := oacpAsObject(envValue)
	envOK = envOK && envErr == nil
	artifactID := ""
	if envOK {
		if id, ok := oacpString(env, "artifact_id"); ok {
			artifactID = id
		}
	}
	refuse := func(code OacpRefusalCode, message string) OacpVerification {
		return OacpVerification{Valid: false, ArtifactID: artifactID, RefusalCode: code, Message: message}
	}

	if !envOK {
		return refuse(OacpArtifactMissingOrInvalid, "The envelope is not a JSON object.")
	}
	payValue, payErr := parseOacpJSON(payload, false)
	if _, ok := oacpAsObject(payValue); !ok || payErr != nil {
		return refuse(OacpArtifactMissingOrInvalid, "The payload is not a JSON object.")
	}

	// 1. A detached compact JWS: BASE64URL(header) || '..' || BASE64URL(signature).
	signature, ok := oacpString(env, "signature")
	if !ok || oacpUTF16Len(signature) > oacpMaxSignatureLength {
		return refuse(OacpSignatureMissingOrPlaceholder, "The artifact has no detached JWS signature.")
	}
	parts := strings.Split(signature, ".")
	if len(parts) != 3 || parts[1] != "" || parts[0] == "" || parts[2] == "" ||
		!oacpIsBase64urlShaped(parts[0]) || !oacpIsBase64urlShaped(parts[2]) {
		return refuse(OacpSignatureMissingOrPlaceholder, "The signature is not a detached compact JWS.")
	}
	headerSegment, signatureSegment := parts[0], parts[2]

	// 2. The profile has one algorithm.
	if alg, ok := oacpString(env, "signature_alg"); !ok || alg != OacpSignatureAlg {
		return refuse(OacpSignatureAlgorithmUnsupported, "The artifact signature algorithm is not ES256.")
	}

	// 3. The payload is the one the envelope commits to.
	canonicalPayload, err := canonicalizeOacpValue(payValue)
	if err != nil {
		return refuse(OacpArtifactMissingOrInvalid, "The payload has no RFC 8785 canonical form.")
	}
	sum := sha256.Sum256(canonicalPayload)
	payloadHash := hex.EncodeToString(sum[:])
	if h, ok := oacpString(env, "payload_hash"); !ok || h != payloadHash {
		return refuse(OacpPayloadHashMismatch, "The payload does not hash to the envelope payload_hash.")
	}

	// 4. The protected header is exactly the profile's.
	header, headerOK := oacpDecodeJSONSegment(headerSegment)
	issuerKeyID, kidOK := oacpString(env, "issuer_key_id")
	if !headerOK || !oacpHasExactlyKeys(header, "alg", "kid", "typ") ||
		!oacpStringIs(header, "alg", OacpSignatureAlg) ||
		!oacpStringIs(header, "typ", OacpArtifactJWSTyp) ||
		!kidOK || !oacpStringIs(header, "kid", issuerKeyID) {
		return refuse(OacpDetachedJWSVerificationFailed, "The JWS protected header is not the OACP artifact header.")
	}

	// 5. The pinned issuer's key.
	if !oacpStringIs(env, "issuer", opts.Issuer) {
		return refuse(OacpIssuerKeyUntrusted, "The artifact names an issuer other than the pinned one.")
	}
	jwks, err := oacpLoadJWKS(ctx, &opts, false)
	if err != nil {
		return refuse(OacpIssuerKeyUntrusted, "The issuer JWK Set is unavailable.")
	}
	key, reason := selectOacpVerificationKey(jwks, issuerKeyID, "ES256")
	if reason != "" && opts.JWKSFetcher != nil {
		if refreshed, err := oacpLoadJWKS(ctx, &opts, true); err == nil {
			jwks = refreshed
			key, reason = selectOacpVerificationKey(jwks, issuerKeyID, "ES256")
		}
	}
	if reason != "" {
		return refuse(OacpIssuerKeyUntrusted, "The issuer key is not trusted: "+reason+".")
	}

	// 6. ES256 over BASE64URL(header) || '.' || BASE64URL(JCS(envelope without signature)).
	unsigned := &oacpObject{members: make(map[string]any, len(env.members))}
	for _, k := range env.keys {
		if k == "signature" {
			continue
		}
		unsigned.keys = append(unsigned.keys, k)
		unsigned.members[k] = env.members[k]
	}
	canonicalEnvelope, err := canonicalizeOacpValue(unsigned)
	if err != nil {
		return refuse(OacpDetachedJWSVerificationFailed, "The envelope has no RFC 8785 canonical form.")
	}
	signingInput := headerSegment + "." + base64.RawURLEncoding.EncodeToString(canonicalEnvelope)
	signatureBytes, ok := oacpDecodeBase64urlStrict(signatureSegment)
	if !ok || !verifyOacpJWSSignature("ES256", key, signingInput, signatureBytes) {
		return refuse(OacpDetachedJWSVerificationFailed, "The detached JWS does not verify.")
	}

	// 7. Type, safety, private fields, time, TTL and scope.
	artifactType, typeOK := oacpString(env, "artifact_type")
	var maxTTL int64
	ttlKnown := false
	if typeOK {
		if v, ok := opts.MaxTTLSeconds[artifactType]; ok {
			maxTTL, ttlKnown = v, true
		} else if v, ok := oacpArtifactMaxTTLSeconds[artifactType]; ok {
			maxTTL, ttlKnown = v, true
		}
	}
	if !typeOK || !ttlKnown || artifactID == "" {
		return refuse(OacpArtifactMissingOrInvalid, "The artifact type or id is missing or unknown.")
	}
	safetyValue, _ := env.get("safety")
	safety, ok := oacpAsObject(safetyValue)
	if !ok || !oacpBool(safety, "public_safe", true) || !oacpBool(safety, "contains_private_data", false) {
		return refuse(OacpArtifactMissingOrInvalid, "The artifact safety metadata is not public-safe.")
	}
	if oacpHasForbiddenField(payValue) {
		return refuse(OacpArtifactMissingOrInvalid, "The payload contains private or enabling fields.")
	}
	nowTime := opts.Now
	if nowTime.IsZero() {
		nowTime = time.Now()
	}
	now := nowTime.UnixMilli()
	issuedAtValue, _ := env.get("issued_at")
	expiresAtValue, _ := env.get("expires_at")
	issuedAt, issuedOK := oacpTimestamp(issuedAtValue)
	expiresAt, expiresOK := oacpTimestamp(expiresAtValue)
	notBeforeValue, hasNotBefore := env.get("not_before")
	var notBefore int64
	notBeforeOK := true
	if hasNotBefore {
		notBefore, notBeforeOK = oacpTimestamp(notBeforeValue)
	}
	if !issuedOK || !expiresOK || !notBeforeOK {
		return refuse(OacpArtifactMissingOrInvalid, "The artifact timestamps are invalid.")
	}
	if hasNotBefore && now < notBefore {
		return refuse(OacpArtifactNotYetValid, "The artifact is not yet valid.")
	}
	if now > expiresAt {
		return refuse(OacpArtifactExpiredOrStale, "The artifact has expired.")
	}
	ttlSeconds := oacpFloorDiv(expiresAt-issuedAt, 1000)
	if ttlSeconds < 0 || ttlSeconds > maxTTL {
		return refuse(OacpArtifactTTLExceedsDefault, "The artifact lifetime exceeds the pinned default.")
	}
	if scope := opts.ExpectedScope; scope != nil {
		members := []struct {
			name string
			want *string
		}{
			{"tenant_id", scope.TenantID},
			{"merchant_id", scope.MerchantID},
			{"seller_agent_id", scope.SellerAgentID},
			{"buyer_agent_id", scope.BuyerAgentID},
		}
		for _, m := range members {
			if m.want != nil && !oacpStringIs(env, m.name, *m.want) {
				return refuse(OacpArtifactScopeMismatch, "The artifact "+m.name+" is outside the expected scope.")
			}
		}
	}

	expiresAtText, _ := oacpString(env, "expires_at")
	accepted := OacpVerification{
		Valid:        true,
		ArtifactID:   artifactID,
		ArtifactType: artifactType,
		IssuerKeyID:  issuerKeyID,
		PayloadHash:  payloadHash,
		ExpiresAt:    expiresAtText,
	}
	if opts.SkipStatusCheck {
		accepted.Status = OacpVerificationStatusNotChecked
		return accepted
	}

	// 8. Token Status List (draft-ietf-oauth-status-list §6.2, §8.3), fail closed.
	var reference *oacpObject
	if statusValue, ok := env.get("status"); ok {
		if status, ok := oacpAsObject(statusValue); ok {
			listValue, _ := status.get("status_list")
			reference, _ = oacpAsObject(listValue)
		}
	}
	if reference == nil {
		return refuse(OacpRevocationStatusUnavailable, "The envelope has no status list entry.")
	}
	uri, uriOK := oacpString(reference, "uri")
	idxValue, _ := reference.get("idx")
	idx, idxOK := oacpSafeInteger(idxValue)
	if !uriOK || !idxOK || idx < 0 || !oacpStringIs(env, "revocation_status_url", uri) ||
		!oacpStatusURIAllowed(uri, opts.AllowLoopbackHTTP) {
		return refuse(OacpRevocationStatusUnavailable, "The envelope status list entry is malformed.")
	}
	if opts.StatusListFetcher == nil {
		return refuse(OacpRevocationStatusUnavailable, "No status list fetcher is configured.")
	}
	token, err := opts.StatusListFetcher(ctx, uri)
	if err != nil {
		return refuse(OacpRevocationStatusUnavailable, "The status list cannot be read: "+err.Error())
	}
	status, err := readOacpStatusParsed(token, uri, idx, jwks, opts.Issuer, nowTime)
	if err != nil {
		return refuse(OacpRevocationStatusUnavailable, "The status list cannot be read: "+err.Error())
	}
	switch status {
	case OacpTokenStatusInvalid:
		return refuse(OacpArtifactRevoked, "The artifact is revoked.")
	case OacpTokenStatusSuspended:
		return refuse(OacpArtifactSuspended, "The artifact is suspended.")
	case OacpTokenStatusValid:
		accepted.Status = OacpVerificationStatusValid
		return accepted
	}
	return refuse(OacpRevocationStatusUnavailable, fmt.Sprintf("The status list holds an unknown status %d.", status))
}

func oacpStringIs(o *oacpObject, key, want string) bool {
	s, ok := oacpString(o, key)
	return ok && s == want
}

func oacpHasExactlyKeys(o *oacpObject, keys ...string) bool {
	if len(o.keys) != len(keys) {
		return false
	}
	for _, k := range keys {
		if _, ok := o.members[k]; !ok {
			return false
		}
	}
	return true
}

func oacpFloorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}
