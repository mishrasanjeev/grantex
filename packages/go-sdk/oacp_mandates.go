package grantex

// Relying-party verification of OACP mandates (profile oacp.mandate.v1).
//
// Grantex issues Intent, Cart and Payment mandates as compact ES256 JWTs
// (RFC 7519, RFC 7518 section 3.4) signed by its OACP issuer key ("oacp-"
// kid in the issuer JWK Set), with typ oacp-intent-mandate+jwt,
// oacp-cart-mandate+jwt or oacp-payment-mandate+jwt. The claims carry AP2
// v0.2 member names where AP2 has one and every mandate names its entry on
// the OACP Token Status List (status.status_list, draft-ietf-oauth-status-list
// section 6.1).
//
// VerifyOacpMandate mirrors verifyOacpMandate in TypeScript, verify_oacp_mandate
// in Python and the auth service verifier: it stops at the first failure with
// the same refusal code. CheckOacpMandateChain checks verified mandates against
// each other. Shared vectors: spec/examples/oacp/oacp-mandates-v1.json and
// oacp-mandates-v1-extra.json.

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

// OacpMandateType is "intent", "cart" or "payment".
type OacpMandateType string

const (
	OacpMandateIntent  OacpMandateType = "intent"
	OacpMandateCart    OacpMandateType = "cart"
	OacpMandatePayment OacpMandateType = "payment"

	OacpMandateVersion            = "oacp.mandate.v1"
	OacpMandateMaxLifetimeSeconds = 600
	OacpMandateClockSkewSeconds   = 60
	oacpMandateMaxLength          = 32768
)

// OacpMandateTyp is the JWS typ of each mandate type.
var OacpMandateTyp = map[OacpMandateType]string{
	OacpMandateIntent:  "oacp-intent-mandate+jwt",
	OacpMandateCart:    "oacp-cart-mandate+jwt",
	OacpMandatePayment: "oacp-payment-mandate+jwt",
}

// OacpPaymentRails are the rails a PaymentMandate may name.
var OacpPaymentRails = []string{"plural", "upi_autopay", "card_network_token"}

// OacpMandateRefusalCode is why VerifyOacpMandate refused a mandate.
type OacpMandateRefusalCode string

// The refusal codes, in check order.
const (
	OacpMandateMalformed            OacpMandateRefusalCode = "mandate_malformed"
	OacpMandateAlgorithmUnsupported OacpMandateRefusalCode = "mandate_algorithm_unsupported"
	OacpMandateTypeMismatch         OacpMandateRefusalCode = "mandate_type_mismatch"
	OacpMandateIssuerKeyUntrusted   OacpMandateRefusalCode = "issuer_key_untrusted"
	OacpMandateSignatureInvalid     OacpMandateRefusalCode = "mandate_signature_invalid"
	OacpMandateIssuerMismatch       OacpMandateRefusalCode = "mandate_issuer_mismatch"
	OacpMandateClaimsInvalid        OacpMandateRefusalCode = "mandate_claims_invalid"
	OacpMandateNotYetValid          OacpMandateRefusalCode = "mandate_not_yet_valid"
	OacpMandateExpired              OacpMandateRefusalCode = "mandate_expired"
	OacpMandateLifetimeExceeded     OacpMandateRefusalCode = "mandate_lifetime_exceeded"
	OacpMandateAudienceMismatch     OacpMandateRefusalCode = "mandate_audience_mismatch"
	OacpMandateStatusUnavailable    OacpMandateRefusalCode = "revocation_status_unavailable"
	OacpMandateRevoked              OacpMandateRefusalCode = "mandate_revoked"
	OacpMandateSuspended            OacpMandateRefusalCode = "mandate_suspended"
	OacpMandateChainMismatch        OacpMandateRefusalCode = "mandate_chain_mismatch"
)

// OacpMandateVerifyOptions configures VerifyOacpMandate.
type OacpMandateVerifyOptions struct {
	// Issuer is the pinned issuer identifier; iss must equal it.
	Issuer string
	// JWKS is the issuer's JWK Set, used when JWKSFetcher is nil.
	JWKS json.RawMessage
	// JWKSFetcher returns the issuer's JWK Set (NewOacpJWKSFetcher).
	JWKSFetcher func(ctx context.Context, refresh bool) (json.RawMessage, error)
	// Now is the time to verify at. The zero value means time.Now().
	Now time.Time
	// ExpectedType refuses a mandate of another type (mandate_type_mismatch).
	ExpectedType OacpMandateType
	// ExpectedAudience refuses a mandate for another merchant.
	ExpectedAudience string
	// StatusListFetcher fetches the Token Status List the mandate names.
	StatusListFetcher func(ctx context.Context, uri string) (string, error)
	// Status, when set, is the status the caller already read (0 VALID,
	// 1 INVALID, 2 SUSPENDED, any other value unavailable); used instead of
	// StatusListFetcher.
	Status *int
	// SkipStatusCheck verifies signatures offline only; Status is then "not_checked".
	SkipStatusCheck bool
	// AllowLoopbackHTTP accepts an http status URI on a loopback host.
	AllowLoopbackHTTP bool
}

// OacpMandateVerification is the outcome of VerifyOacpMandate.
type OacpMandateVerification struct {
	Valid       bool
	RefusalCode OacpMandateRefusalCode
	Message     string
	MandateType OacpMandateType
	JTI         string
	KID         string
	// MandateHash is the lowercase hex SHA-256 of the compact JWT.
	MandateHash string
	// Claims is the verified claims set (set only for a valid mandate).
	Claims map[string]any
	// Status is "valid" or "not_checked" for a valid mandate.
	Status string
}

var (
	oacpMandateB64URL   = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	oacpMandateHash43   = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	oacpMandateCurrency = regexp.MustCompile(`^[A-Z]{3}$`)
	oacpMandateRef      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$`)
	oacpMandateAMR      = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	oacpMandateTokType  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	oacpMandateHex64    = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// OacpCheckoutHash is the AP2 checkout_hash of a checkout JSON text: unpadded
// base64url SHA-256 of its RFC 8785 form.
func OacpCheckoutHash(checkout json.RawMessage) (string, error) {
	v, err := parseOacpJSON(checkout, false)
	if err != nil {
		return "", err
	}
	canonical, err := canonicalizeOacpValue(v)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// OacpMandateHash is the lowercase hex SHA-256 of a compact mandate JWT.
func OacpMandateHash(mandate string) string {
	sum := sha256.Sum256([]byte(mandate))
	return hex.EncodeToString(sum[:])
}

func oacpMember(o *oacpObject, key string) any {
	if o == nil {
		return nil
	}
	v, _ := o.get(key)
	return v
}

func oacpObj(v any) *oacpObject {
	o, ok := oacpAsObject(v)
	if !ok {
		return nil
	}
	return o
}

func oacpMatch(re *regexp.Regexp, v any) bool {
	s, ok := v.(string)
	return ok && re.MatchString(s)
}

func oacpNonNegInt(v any) (int64, bool) {
	n, ok := oacpSafeInteger(v)
	return n, ok && n >= 0
}

func oacpIsAmount(v any) bool {
	o := oacpObj(v)
	_, ok := oacpNonNegInt(oacpMember(o, "value"))
	return o != nil && ok && oacpMatch(oacpMandateCurrency, oacpMember(o, "currency"))
}

func oacpAsString(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

func oacpMandateCommonValid(c *oacpObject) bool {
	if _, ok := oacpAsString(oacpMember(c, "iss")); !ok {
		return false
	}
	for _, k := range []string{"sub", "aud", "jti", "tenant_id", "merchant_id", "buyer_agent_id", "passport_ref", "consent_ref"} {
		if !oacpMatch(oacpMandateRef, oacpMember(c, k)) {
			return false
		}
	}
	if _, ok := oacpNonNegInt(oacpMember(c, "iat")); !ok {
		return false
	}
	if _, ok := oacpNonNegInt(oacpMember(c, "exp")); !ok {
		return false
	}
	if !oacpStringIs(c, "mandate_version", OacpMandateVersion) {
		return false
	}
	aud, _ := oacpAsString(oacpMember(c, "aud"))
	if !oacpStringIs(c, "merchant_id", aud) {
		return false
	}
	presence, _ := oacpAsString(oacpMember(c, "presence"))
	if presence != "human_present" && presence != "human_not_present" {
		return false
	}
	amr, ok := oacpMember(c, "amr").([]any)
	if !ok {
		return false
	}
	for _, m := range amr {
		if !oacpMatch(oacpMandateAMR, m) {
			return false
		}
	}
	entry := oacpObj(oacpMember(oacpObj(oacpMember(c, "status")), "status_list"))
	if entry == nil || len(entry.keys) != 2 {
		return false
	}
	if _, ok := oacpAsString(oacpMember(entry, "uri")); !ok {
		return false
	}
	_, ok = oacpNonNegInt(oacpMember(entry, "idx"))
	return ok
}

func oacpStrings(v any) ([]string, bool) {
	arr, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		s, ok := x.(string)
		if !ok || s == "" {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

func oacpContains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

func oacpMandateTypeValid(t OacpMandateType, c *oacpObject) bool {
	merchant, _ := oacpAsString(oacpMember(c, "merchant_id"))
	switch t {
	case OacpMandateIntent:
		i := oacpObj(oacpMember(c, "intent"))
		if i == nil || !oacpMatch(oacpMandateHash43, oacpMember(i, "description_hash")) || !oacpIsAmount(oacpMember(i, "max_amount")) {
			return false
		}
		merchants, ok := oacpStrings(oacpMember(i, "merchants"))
		if !ok || !oacpContains(merchants, merchant) {
			return false
		}
		exp, ok := oacpAsString(oacpMember(i, "expires_at"))
		if !ok {
			return false
		}
		if _, ok := ParseOacpTimestamp(exp); !ok {
			return false
		}
		constraints, ok := oacpMember(i, "constraints").([]any)
		if !ok {
			return false
		}
		for _, x := range constraints {
			if _, ok := oacpAsString(oacpMember(oacpObj(x), "type")); !ok {
				return false
			}
		}
		if cnfValue, has := c.get("cnf"); has {
			if oacpObj(oacpMember(oacpObj(cnfValue), "jwk")) == nil {
				return false
			}
		}
		return true
	case OacpMandateCart:
		cart := oacpObj(oacpMember(c, "cart"))
		if cart == nil || !oacpMatch(oacpMandateHash43, oacpMember(cart, "checkout_hash")) ||
			!oacpMatch(oacpMandateRef, oacpMember(cart, "checkout_id")) || !oacpIsAmount(oacpMember(cart, "total")) ||
			!oacpMatch(oacpMandateRef, oacpMember(c, "intent_mandate_jti")) {
			return false
		}
		items, ok := oacpMember(cart, "line_items").([]any)
		if !ok || len(items) == 0 {
			return false
		}
		for _, x := range items {
			item := oacpObj(x)
			id, idOK := oacpAsString(oacpMember(item, "id"))
			q, qOK := oacpSafeInteger(oacpMember(item, "quantity"))
			if item == nil || !idOK || id == "" || !qOK || q < 1 || !oacpMatch(oacpMandateHash43, oacpMember(item, "digest")) {
				return false
			}
		}
		w, hasW := c.get("webauthn")
		if oacpStringIs(c, "presence", "human_present") {
			wo := oacpObj(w)
			checkout, _ := oacpAsString(oacpMember(cart, "checkout_hash"))
			_, rp := oacpAsString(oacpMember(wo, "rp_id"))
			_, origin := oacpAsString(oacpMember(wo, "origin"))
			_, asserted := oacpAsString(oacpMember(wo, "asserted_at"))
			amr, _ := oacpMember(c, "amr").([]any)
			passkey := false
			for _, m := range amr {
				if m == "passkey" {
					passkey = true
				}
			}
			return wo != nil && oacpMatch(oacpMandateHex64, oacpMember(wo, "digest")) &&
				oacpStringIs(wo, "challenge", checkout) && rp && origin && asserted &&
				oacpBool(wo, "user_verified", true) &&
				oacpMatch(oacpMandateHex64, oacpMember(wo, "credential_ref")) && passkey
		}
		return !hasW
	case OacpMandatePayment:
		p := oacpObj(oacpMember(c, "payment"))
		if p == nil || !oacpMatch(oacpMandateHash43, oacpMember(p, "transaction_id")) ||
			!oacpMatch(oacpMandateCurrency, oacpMember(p, "currency")) ||
			!oacpMatch(oacpMandateRef, oacpMember(p, "cart_mandate_jti")) {
			return false
		}
		if _, ok := oacpNonNegInt(oacpMember(p, "amount")); !ok {
			return false
		}
		if !oacpStringIs(oacpObj(oacpMember(p, "payee")), "id", merchant) {
			return false
		}
		rail, _ := oacpAsString(oacpMember(p, "rail"))
		if !oacpContains(OacpPaymentRails, rail) {
			return false
		}
		binding := oacpObj(oacpMember(p, "token_binding"))
		return binding != nil && oacpMatch(oacpMandateTokType, oacpMember(binding, "type")) &&
			oacpMatch(oacpMandateRef, oacpMember(binding, "id"))
	}
	return false
}

// VerifyOacpMandate verifies one OACP mandate. It never panics or returns an
// error for a bad mandate: the result says why it is refused.
func VerifyOacpMandate(ctx context.Context, mandate string, opts OacpMandateVerifyOptions) OacpMandateVerification {
	if ctx == nil {
		ctx = context.Background()
	}
	var mandateType OacpMandateType
	refuse := func(code OacpMandateRefusalCode, message string) OacpMandateVerification {
		return OacpMandateVerification{Valid: false, RefusalCode: code, Message: message, MandateType: mandateType}
	}

	// 1.
	parts := strings.Split(mandate, ".")
	if len(mandate) > oacpMandateMaxLength || len(parts) != 3 {
		return refuse(OacpMandateMalformed, "The mandate is not a compact JWS.")
	}
	for _, p := range parts {
		if !oacpMandateB64URL.MatchString(p) {
			return refuse(OacpMandateMalformed, "The mandate is not a compact JWS.")
		}
	}

	// 2.
	header, ok := oacpDecodeJSONSegment(parts[0])
	if !ok {
		return refuse(OacpMandateMalformed, "The header is not a JSON object.")
	}
	if !oacpStringIs(header, "alg", "ES256") {
		return refuse(OacpMandateAlgorithmUnsupported, "The mandate algorithm is not ES256.")
	}
	kid, kidOK := oacpString(header, "kid")
	if len(header.keys) != 3 || !kidOK {
		return refuse(OacpMandateMalformed, "The header is not exactly alg, kid and typ.")
	}
	typ, typOK := header.get("typ")
	if !typOK {
		return refuse(OacpMandateMalformed, "The header is not exactly alg, kid and typ.")
	}
	for t, want := range OacpMandateTyp {
		if typ == want {
			mandateType = t
		}
	}
	if mandateType == "" || (opts.ExpectedType != "" && mandateType != opts.ExpectedType) {
		return refuse(OacpMandateTypeMismatch, "The mandate typ is not the expected OACP mandate type.")
	}

	// 3.
	if !strings.HasPrefix(kid, "oacp-") {
		return refuse(OacpMandateIssuerKeyUntrusted, "The kid is not an OACP issuer key.")
	}
	artifactOpts := OacpVerifyOptions{JWKS: opts.JWKS, JWKSFetcher: opts.JWKSFetcher}
	jwks, err := oacpLoadJWKS(ctx, &artifactOpts, false)
	if err != nil {
		return refuse(OacpMandateIssuerKeyUntrusted, "The issuer JWK Set is unavailable.")
	}
	key, reason := selectOacpVerificationKey(jwks, kid, "ES256")
	if reason != "" && opts.JWKSFetcher != nil {
		if refreshed, err := oacpLoadJWKS(ctx, &artifactOpts, true); err == nil {
			jwks = refreshed
			key, reason = selectOacpVerificationKey(jwks, kid, "ES256")
		}
	}
	if reason != "" {
		return refuse(OacpMandateIssuerKeyUntrusted, "The issuer key is not trusted: "+reason+".")
	}

	// 4.
	signature, ok := oacpDecodeBase64urlStrict(parts[2])
	if !ok || !verifyOacpJWSSignature("ES256", key, parts[0]+"."+parts[1], signature) {
		return refuse(OacpMandateSignatureInvalid, "The mandate signature does not verify.")
	}

	// 5.
	claims, ok := oacpDecodeJSONSegment(parts[1])
	if !ok {
		return refuse(OacpMandateMalformed, "The claims are not a JSON object.")
	}

	// 6.
	if !oacpStringIs(claims, "iss", opts.Issuer) {
		return refuse(OacpMandateIssuerMismatch, "The mandate names another issuer.")
	}

	// 7.
	if !oacpMandateCommonValid(claims) || !oacpMandateTypeValid(mandateType, claims) {
		return refuse(OacpMandateClaimsInvalid, "The "+string(mandateType)+" mandate claims are missing or malformed.")
	}

	// 8.
	nowTime := opts.Now
	if nowTime.IsZero() {
		nowTime = time.Now()
	}
	nowS := nowTime.Unix()
	iat, _ := oacpSafeInteger(oacpMember(claims, "iat"))
	exp, _ := oacpSafeInteger(oacpMember(claims, "exp"))
	if iat > nowS+OacpMandateClockSkewSeconds {
		return refuse(OacpMandateNotYetValid, "The mandate is not yet valid.")
	}
	if nowS >= exp {
		return refuse(OacpMandateExpired, "The mandate has expired.")
	}
	if exp <= iat || exp-iat > OacpMandateMaxLifetimeSeconds {
		return refuse(OacpMandateLifetimeExceeded, "The mandate lifetime exceeds the profile maximum.")
	}

	// 9.
	if opts.ExpectedAudience != "" && !oacpStringIs(claims, "aud", opts.ExpectedAudience) {
		return refuse(OacpMandateAudienceMismatch, "The mandate is for another merchant.")
	}

	payloadBytes, _ := oacpDecodeBase64urlStrict(parts[1])
	var claimsMap map[string]any
	if err := json.Unmarshal(payloadBytes, &claimsMap); err != nil {
		return refuse(OacpMandateMalformed, "The claims are not a JSON object.")
	}
	jti, _ := oacpString(claims, "jti")
	accepted := OacpMandateVerification{
		Valid: true, MandateType: mandateType, JTI: jti, KID: kid,
		MandateHash: OacpMandateHash(mandate), Claims: claimsMap,
	}
	if opts.SkipStatusCheck {
		accepted.Status = "not_checked"
		return accepted
	}

	// 10.
	entry := oacpObj(oacpMember(oacpObj(oacpMember(claims, "status")), "status_list"))
	uri, _ := oacpString(entry, "uri")
	idx, _ := oacpSafeInteger(oacpMember(entry, "idx"))
	if !oacpStatusURIAllowed(uri, opts.AllowLoopbackHTTP) {
		return refuse(OacpMandateStatusUnavailable, "The mandate does not name an https status list.")
	}
	var status int
	switch {
	case opts.Status != nil:
		status = *opts.Status
	case opts.StatusListFetcher == nil:
		return refuse(OacpMandateStatusUnavailable, "No status list fetcher is configured.")
	default:
		token, err := opts.StatusListFetcher(ctx, uri)
		if err != nil {
			return refuse(OacpMandateStatusUnavailable, "The status list cannot be fetched: "+err.Error())
		}
		status, err = readOacpStatusParsed(token, uri, idx, jwks, opts.Issuer, time.Unix(nowS, 0))
		if err != nil {
			return refuse(OacpMandateStatusUnavailable, "The status list cannot be read: "+err.Error())
		}
	}
	switch status {
	case OacpTokenStatusValid:
		accepted.Status = "valid"
		return accepted
	case OacpTokenStatusInvalid:
		return refuse(OacpMandateRevoked, "The mandate is revoked.")
	case OacpTokenStatusSuspended:
		return refuse(OacpMandateSuspended, "The mandate is suspended.")
	}
	return refuse(OacpMandateStatusUnavailable, "The mandate status could not be established.")
}

func oacpClaimObj(m map[string]any, key string) map[string]any {
	o, _ := m[key].(map[string]any)
	return o
}

// CheckOacpMandateChain checks the claims of verified mandates (any may be
// nil) against each other. It returns "" when they are consistent, else
// mandate_chain_mismatch.
func CheckOacpMandateChain(intent, cart, payment map[string]any) OacpMandateRefusalCode {
	same := func(a, b map[string]any) bool {
		for _, k := range []string{"tenant_id", "merchant_id", "sub", "buyer_agent_id", "consent_ref", "iss"} {
			if a[k] != b[k] {
				return false
			}
		}
		return true
	}
	num := func(v any) (float64, bool) { f, ok := v.(float64); return f, ok }
	if intent != nil && cart != nil {
		if !same(intent, cart) || cart["intent_mandate_jti"] != intent["jti"] {
			return OacpMandateChainMismatch
		}
		capAmount := oacpClaimObj(oacpClaimObj(intent, "intent"), "max_amount")
		total := oacpClaimObj(oacpClaimObj(cart, "cart"), "total")
		capValue, ok1 := num(capAmount["value"])
		totalValue, ok2 := num(total["value"])
		if !ok1 || !ok2 || total["currency"] != capAmount["currency"] || totalValue > capValue {
			return OacpMandateChainMismatch
		}
		merchants, _ := oacpClaimObj(intent, "intent")["merchants"].([]any)
		found := false
		for _, m := range merchants {
			if m == cart["merchant_id"] {
				found = true
			}
		}
		cartExp, _ := num(cart["exp"])
		intentExp, _ := num(intent["exp"])
		if !found || cartExp > intentExp {
			return OacpMandateChainMismatch
		}
		if intent["presence"] == "human_present" && cart["presence"] != "human_present" {
			return OacpMandateChainMismatch
		}
	}
	if cart != nil && payment != nil {
		p := oacpClaimObj(payment, "payment")
		c := oacpClaimObj(cart, "cart")
		total := oacpClaimObj(c, "total")
		if !same(cart, payment) || p == nil || c == nil || p["cart_mandate_jti"] != cart["jti"] {
			return OacpMandateChainMismatch
		}
		payExp, _ := num(payment["exp"])
		cartExp, _ := num(cart["exp"])
		if p["transaction_id"] != c["checkout_hash"] || p["amount"] != total["value"] ||
			p["currency"] != total["currency"] || payment["presence"] != cart["presence"] || payExp > cartExp {
			return OacpMandateChainMismatch
		}
	}
	if intent != nil && payment != nil && cart == nil {
		return OacpMandateChainMismatch
	}
	return ""
}
