package grantex

// Token Status List reading for OACP artifacts (draft-ietf-oauth-status-list,
// the revision the auth service implements: -21).
//
// An OACP envelope is a Referenced Token (§6.2): it carries
// status.status_list = {idx, uri}. The issuer serves the list at uri as a
// Status List Token (§5.1), media type application/statuslist+jwt (§8.2),
// signed with a key from the same JWK Set as the artifact. The list is bits
// wide per entry, packed from the least significant bit of each byte,
// DEFLATE-compressed in the ZLIB format and base64url encoded (§4.1, §4.2).
//
// Everything here fails closed: a list that cannot be fetched, verified or
// decoded never reads as VALID.

import (
	"bytes"
	"compress/zlib"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// draft-ietf-oauth-status-list §7.1 status types.
const (
	OacpTokenStatusValid     = 0x00
	OacpTokenStatusInvalid   = 0x01
	OacpTokenStatusSuspended = 0x02
)

const (
	// OacpStatusListTokenTyp is the §5.1 typ of a Status List Token.
	OacpStatusListTokenTyp = "statuslist+jwt"
	// OacpStatusListTokenMediaType is the §8.2 media type of a Status List
	// Token response.
	OacpStatusListTokenMediaType = "application/statuslist+jwt"
	// OacpStatusListMaxDecodedBytes bounds an inflated list, so a hostile
	// list cannot exhaust memory.
	OacpStatusListMaxDecodedBytes = 16 * 1024 * 1024
	// OacpStatusListClockSkewSeconds is the clock skew allowed on a list's iat.
	OacpStatusListClockSkewSeconds = 60
)

// OacpStatusListError is a Status List Token or list that cannot be read.
type OacpStatusListError struct {
	Message string
}

func (e *OacpStatusListError) Error() string { return e.Message }

func oacpStatusListErr(format string, args ...any) error {
	return &OacpStatusListError{Message: fmt.Sprintf(format, args...)}
}

// OacpStatusList is a decoded §4.2 StatusList.
type OacpStatusList struct {
	Bits  int
	bytes []byte
}

// Size is the number of entries the list holds.
func (l *OacpStatusList) Size() int { return len(l.bytes) * (8 / l.Bits) }

// StatusAt returns the status at idx, or an error for an index outside the
// list (§8.3 step 6).
func (l *OacpStatusList) StatusAt(idx int) (int, error) {
	if idx < 0 || idx >= l.Size() {
		return 0, oacpStatusListErr("index %d is outside a list of %d entries", idx, l.Size())
	}
	perByte := 8 / l.Bits
	mask := (1 << l.Bits) - 1
	// §4.1 step 3: entries are packed from the least significant bit.
	return int(l.bytes[idx/perByte]>>((idx%perByte)*l.Bits)) & mask, nil
}

// DecodeOacpStatusList reads a §4.2 StatusList {bits, lst}: bits must be 1,
// 2, 4 or 8 and lst the base64url of ZLIB data inflating to at most
// OacpStatusListMaxDecodedBytes.
func DecodeOacpStatusList(bits int, lst string) (*OacpStatusList, error) {
	if bits != 1 && bits != 2 && bits != 4 && bits != 8 {
		return nil, oacpStatusListErr("bits must be 1, 2, 4 or 8")
	}
	if lst == "" {
		return nil, oacpStatusListErr("lst must be a base64url string")
	}
	compressed, ok := oacpDecodeBase64urlStrict(lst)
	if !ok {
		return nil, oacpStatusListErr("lst must be a base64url string")
	}
	// §8.3 step 5: a decompressor for DEFLATE in the ZLIB format.
	zr, err := zlib.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, oacpStatusListErr("lst is not ZLIB data: %v", err)
	}
	defer zr.Close()
	decoded, err := io.ReadAll(io.LimitReader(zr, OacpStatusListMaxDecodedBytes+1))
	if err != nil {
		return nil, oacpStatusListErr("lst is not ZLIB data: %v", err)
	}
	if len(decoded) > OacpStatusListMaxDecodedBytes {
		return nil, oacpStatusListErr("lst inflates to more than %d bytes", OacpStatusListMaxDecodedBytes)
	}
	return &OacpStatusList{Bits: bits, bytes: decoded}, nil
}

// decodeOacpStatusListValue reads a parsed status_list claim.
func decodeOacpStatusListValue(v any) (*OacpStatusList, error) {
	obj, isObj := oacpAsObject(v)
	_, isArr := v.([]any)
	if !isObj && !isArr {
		return nil, oacpStatusListErr("status_list must be an object")
	}
	if isArr {
		return nil, oacpStatusListErr("bits must be 1, 2, 4 or 8")
	}
	bitsValue, _ := obj.get("bits")
	n, ok := bitsValue.(oacpNumber)
	bits := int(n.value)
	if !ok || float64(bits) != n.value || (bits != 1 && bits != 2 && bits != 4 && bits != 8) {
		return nil, oacpStatusListErr("bits must be 1, 2, 4 or 8")
	}
	lst, ok := oacpString(obj, "lst")
	if !ok || lst == "" {
		return nil, oacpStatusListErr("lst must be a base64url string")
	}
	return DecodeOacpStatusList(bits, lst)
}

// ReadOacpStatus verifies a Status List Token (§5.1, §8.3) against the
// issuer's JWK Set and returns the status at idx. uri is the URI the
// artifact names (the token's sub must equal it) and issuer the pinned
// issuer (a token with an iss must name it). Any problem is an
// *OacpStatusListError.
func ReadOacpStatus(token, uri string, idx int, jwks json.RawMessage, issuer string, now time.Time) (int, error) {
	set, err := parseOacpJSON(jwks, true)
	if err != nil {
		set = nil
	}
	return readOacpStatusParsed(token, uri, int64(idx), set, issuer, now)
}

func readOacpStatusParsed(token, uri string, idx int64, jwks any, issuer string, now time.Time) (int, error) {
	parts := strings.Split(oacpTrimJS(token), ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return 0, oacpStatusListErr("the status list is not a compact JWS")
	}
	headerSegment, payloadSegment, signatureSegment := parts[0], parts[1], parts[2]
	header, ok := oacpDecodeJSONSegment(headerSegment)
	if !ok {
		return 0, oacpStatusListErr("the status list header is not a JSON object")
	}
	if !oacpStringIs(header, "typ", OacpStatusListTokenTyp) {
		return 0, oacpStatusListErr("the status list typ is not %s", OacpStatusListTokenTyp)
	}
	alg, ok := oacpString(header, "alg")
	if !ok || (alg != "ES256" && alg != "RS256") {
		return 0, oacpStatusListErr("the status list algorithm is not ES256 or RS256")
	}
	if _, crit := header.get("crit"); crit {
		return 0, oacpStatusListErr("the status list header has crit parameters")
	}
	kid, ok := oacpString(header, "kid")
	if !ok || kid == "" {
		return 0, oacpStatusListErr("the status list header has no kid")
	}
	key, reason := selectOacpVerificationKey(jwks, kid, alg)
	if reason != "" {
		return 0, oacpStatusListErr("status list key: %s", reason)
	}
	signature, ok := oacpDecodeBase64urlStrict(signatureSegment)
	if !ok || !verifyOacpJWSSignature(alg, key, headerSegment+"."+payloadSegment, signature) {
		return 0, oacpStatusListErr("the status list signature does not verify")
	}

	claims, ok := oacpDecodeJSONSegment(payloadSegment)
	if !ok {
		return 0, oacpStatusListErr("the status list claims are not a JSON object")
	}
	if !oacpStringIs(claims, "sub", uri) {
		return 0, oacpStatusListErr("the status list sub is not the URI the artifact names")
	}
	if _, present := claims.get("iss"); present && !oacpStringIs(claims, "iss", issuer) {
		return 0, oacpStatusListErr("the status list iss is not the pinned issuer")
	}
	nowS := now.Unix()
	isTime := func(name string) (int64, bool, bool) {
		v, present := claims.get(name)
		if !present {
			return 0, false, true
		}
		n, ok := oacpSafeInteger(v)
		return n, true, ok && n >= 0
	}
	iat, iatPresent, iatOK := isTime("iat")
	if !iatPresent || !iatOK {
		return 0, oacpStatusListErr("the status list iat must be an integer")
	}
	exp, expPresent, expOK := isTime("exp")
	if expPresent && !expOK {
		return 0, oacpStatusListErr("the status list exp must be an integer")
	}
	ttl, ttlPresent, ttlOK := isTime("ttl")
	if ttlPresent && (!ttlOK || ttl == 0) {
		return 0, oacpStatusListErr("the status list ttl must be a positive integer")
	}
	if iat > nowS+OacpStatusListClockSkewSeconds {
		return 0, oacpStatusListErr("the status list iat is in the future")
	}
	switch {
	case expPresent:
		if nowS >= exp {
			return 0, oacpStatusListErr("the status list has expired")
		}
	case ttlPresent:
		if nowS >= iat+ttl {
			return 0, oacpStatusListErr("the status list is older than its ttl")
		}
	default:
		return 0, oacpStatusListErr("the status list has neither exp nor ttl")
	}
	listValue, _ := claims.get("status_list")
	list, err := decodeOacpStatusListValue(listValue)
	if err != nil {
		return 0, err
	}
	if idx < 0 || idx >= int64(list.Size()) {
		return 0, oacpStatusListErr("index %d is outside a list of %d entries", idx, list.Size())
	}
	return list.StatusAt(int(idx))
}
