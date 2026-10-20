package grantex

// VerifyOacpArtifact against the shared OACP vectors
// (spec/examples/oacp/oacp-artifact-jws-v1.json) and Token Status List
// tokens built here with keys generated for the test.

import (
	"bytes"
	"compress/zlib"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type oacpVectorCase struct {
	Name     string          `json:"name"`
	Envelope json.RawMessage `json:"envelope"`
	Payload  json.RawMessage `json:"payload"`
	Expect   string          `json:"expect"`
}

type oacpVectors struct {
	VerifyAt                string          `json:"verify_at"`
	JWKS                    json.RawMessage `json:"jwks"`
	PayloadCanonical        string          `json:"payload_canonical"`
	PayloadHash             string          `json:"payload_hash"`
	SigningPayloadCanonical string          `json:"signing_payload_canonical"`
	StatusList              struct {
		URI string `json:"uri"`
		Idx int    `json:"idx"`
	} `json:"status_list"`
	Cases []oacpVectorCase `json:"cases"`
}

const oacpTestIssuer = "https://issuer.example"

type oacpFixture struct {
	vectors  oacpVectors
	now      time.Time
	nowS     int64
	valid    oacpVectorCase
	jwks     json.RawMessage
	statusEC *ecdsa.PrivateKey
	statusRS *rsa.PrivateKey
	stranger *ecdsa.PrivateKey
}

var (
	oacpFixtureOnce sync.Once
	oacpFixtureVal  *oacpFixture
	oacpFixtureErr  error
)

func oacpB64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func oacpPad32(n *big.Int) []byte {
	out := make([]byte, 32)
	n.FillBytes(out)
	return out
}

func loadOacpFixture(t *testing.T) *oacpFixture {
	t.Helper()
	oacpFixtureOnce.Do(func() {
		f := &oacpFixture{}
		raw, err := os.ReadFile("../../spec/examples/oacp/oacp-artifact-jws-v1.json")
		if err != nil {
			oacpFixtureErr = err
			return
		}
		if err := json.Unmarshal(raw, &f.vectors); err != nil {
			oacpFixtureErr = err
			return
		}
		f.now, err = time.Parse(time.RFC3339Nano, f.vectors.VerifyAt)
		if err != nil {
			oacpFixtureErr = err
			return
		}
		f.nowS = f.now.Unix()
		for _, c := range f.vectors.Cases {
			if c.Name == "valid" {
				f.valid = c
			}
		}
		if f.statusEC, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader); err != nil {
			oacpFixtureErr = err
			return
		}
		if f.stranger, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader); err != nil {
			oacpFixtureErr = err
			return
		}
		if f.statusRS, err = rsa.GenerateKey(rand.Reader, 2048); err != nil {
			oacpFixtureErr = err
			return
		}
		var set struct {
			Keys []map[string]any `json:"keys"`
		}
		if err := json.Unmarshal(f.vectors.JWKS, &set); err != nil {
			oacpFixtureErr = err
			return
		}
		set.Keys = append(set.Keys,
			map[string]any{
				"kty": "EC", "crv": "P-256", "kid": "status-test-es", "alg": "ES256", "use": "sig",
				"x": oacpB64(oacpPad32(f.statusEC.X)), "y": oacpB64(oacpPad32(f.statusEC.Y)),
			},
			map[string]any{
				"kty": "RSA", "kid": "status-test-rs", "alg": "RS256", "use": "sig",
				"n": oacpB64(f.statusRS.N.Bytes()), "e": oacpB64(big.NewInt(int64(f.statusRS.E)).Bytes()),
			},
		)
		f.jwks, oacpFixtureErr = json.Marshal(set)
		oacpFixtureVal = f
	})
	if oacpFixtureErr != nil {
		t.Fatalf("loading OACP fixture: %v", oacpFixtureErr)
	}
	return oacpFixtureVal
}

func (f *oacpFixture) base() OacpVerifyOptions {
	return OacpVerifyOptions{Issuer: oacpTestIssuer, JWKS: f.jwks, Now: f.now}
}

func oacpLst(t *testing.T, statuses map[int]int, size, bits int) string {
	t.Helper()
	perByte := 8 / bits
	b := make([]byte, (size+perByte-1)/perByte)
	for i, s := range statuses {
		b[i/perByte] |= byte(s << ((i % perByte) * bits))
	}
	return oacpDeflate(t, b)
}

func oacpDeflate(t *testing.T, b []byte) string {
	t.Helper()
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	if _, err := w.Write(b); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return oacpB64(buf.Bytes())
}

// oacpDelete removes a claim or header member in statusTokenOptions.
type oacpDelete struct{}

type statusTokenOptions struct {
	claims map[string]any
	header map[string]any
	key    *ecdsa.PrivateKey
	alg    string
}

func (f *oacpFixture) statusToken(t *testing.T, status int, o statusTokenOptions) string {
	t.Helper()
	alg := o.alg
	if alg == "" {
		alg = "ES256"
	}
	kid := "status-test-es"
	if alg == "RS256" {
		kid = "status-test-rs"
	}
	header := map[string]any{"alg": alg, "kid": kid, "typ": "statuslist+jwt"}
	claims := map[string]any{
		"iss":         oacpTestIssuer,
		"sub":         f.vectors.StatusList.URI,
		"iat":         f.nowS - 60,
		"exp":         f.nowS + 3600,
		"ttl":         600,
		"status_list": map[string]any{"bits": 2, "lst": oacpLst(t, map[int]int{f.vectors.StatusList.Idx: status}, 64, 2)},
	}
	apply := func(dst, src map[string]any) {
		for k, v := range src {
			if _, del := v.(oacpDelete); del {
				delete(dst, k)
			} else {
				dst[k] = v
			}
		}
	}
	apply(header, o.header)
	apply(claims, o.claims)
	hj, _ := json.Marshal(header)
	cj, _ := json.Marshal(claims)
	input := oacpB64(hj) + "." + oacpB64(cj)
	digest := sha256.Sum256([]byte(input))
	var sig []byte
	if alg == "ES256" {
		key := o.key
		if key == nil {
			key = f.statusEC
		}
		r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
		if err != nil {
			t.Fatal(err)
		}
		sig = append(oacpPad32(r), oacpPad32(s)...)
	} else {
		var err error
		sig, err = rsa.SignPKCS1v15(rand.Reader, f.statusRS, crypto.SHA256, digest[:])
		if err != nil {
			t.Fatal(err)
		}
	}
	return input + "." + oacpB64(sig)
}

func expectOacpRefusal(t *testing.T, got OacpVerification, want OacpRefusalCode) {
	t.Helper()
	if got.Valid || got.RefusalCode != want {
		t.Fatalf("got valid=%v code=%q (%s), want refusal %q", got.Valid, got.RefusalCode, got.Message, want)
	}
}

func expectOacpValid(t *testing.T, got OacpVerification, status string) {
	t.Helper()
	if !got.Valid || got.Status != status {
		t.Fatalf("got valid=%v code=%q (%s) status=%q, want valid with status %q", got.Valid, got.RefusalCode, got.Message, got.Status, status)
	}
}

func oacpStr(s string) *string { return &s }

func TestOacpVectors(t *testing.T) {
	f := loadOacpFixture(t)
	if len(f.vectors.Cases) == 0 || f.valid.Name == "" {
		t.Fatal("the vectors have no valid case")
	}

	t.Run("canonical payload and signing input", func(t *testing.T) {
		payload, err := canonicalizeOacpJSON(f.valid.Payload)
		if err != nil {
			t.Fatal(err)
		}
		if string(payload) != f.vectors.PayloadCanonical {
			t.Fatalf("payload canonical form:\n got %s\nwant %s", payload, f.vectors.PayloadCanonical)
		}
		sum := sha256.Sum256(payload)
		if hex.EncodeToString(sum[:]) != f.vectors.PayloadHash {
			t.Fatalf("payload hash %x, want %s", sum, f.vectors.PayloadHash)
		}
		v, err := parseOacpJSON(f.valid.Envelope, false)
		if err != nil {
			t.Fatal(err)
		}
		env := v.(*oacpObject)
		unsigned := &oacpObject{members: map[string]any{}}
		for _, k := range env.keys {
			if k != "signature" {
				unsigned.keys = append(unsigned.keys, k)
				unsigned.members[k] = env.members[k]
			}
		}
		signing, err := canonicalizeOacpValue(unsigned)
		if err != nil {
			t.Fatal(err)
		}
		if string(signing) != f.vectors.SigningPayloadCanonical {
			t.Fatalf("signing payload:\n got %s\nwant %s", signing, f.vectors.SigningPayloadCanonical)
		}
	})

	for _, c := range f.vectors.Cases {
		t.Run(c.Name+" -> "+c.Expect, func(t *testing.T) {
			opts := f.base()
			opts.SkipStatusCheck = true
			got := VerifyOacpArtifact(context.Background(), c.Envelope, c.Payload, opts)
			if c.Expect == "valid" {
				expectOacpValid(t, got, OacpVerificationStatusNotChecked)
				if got.PayloadHash != f.vectors.PayloadHash || got.ArtifactID != "oacp_art_01TESTCATALOG" ||
					got.ArtifactType != "catalog_snapshot" || got.IssuerKeyID != "oacp-test-2026-10-a" ||
					got.ExpiresAt != "2026-10-19T16:00:00.000Z" {
					t.Fatalf("unexpected accepted fields: %+v", got)
				}
				return
			}
			expectOacpRefusal(t, got, OacpRefusalCode(c.Expect))
		})
	}
}

func TestOacpChecksAfterSignature(t *testing.T) {
	f := loadOacpFixture(t)
	ctx := context.Background()
	offline := func() OacpVerifyOptions {
		o := f.base()
		o.SkipStatusCheck = true
		return o
	}

	t.Run("issuer mismatch", func(t *testing.T) {
		o := offline()
		o.Issuer = "https://other.example"
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpIssuerKeyUntrusted)
	})

	keysWith := func(t *testing.T, edit func([]map[string]any) []map[string]any) json.RawMessage {
		t.Helper()
		var set struct {
			Keys []map[string]any `json:"keys"`
		}
		if err := json.Unmarshal(f.jwks, &set); err != nil {
			t.Fatal(err)
		}
		set.Keys = edit(set.Keys)
		out, _ := json.Marshal(set)
		return out
	}

	t.Run("duplicate kid", func(t *testing.T) {
		o := offline()
		o.JWKS = keysWith(t, func(keys []map[string]any) []map[string]any { return append(keys, keys[0]) })
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpIssuerKeyUntrusted)
	})

	t.Run("key for another use", func(t *testing.T) {
		o := offline()
		o.JWKS = keysWith(t, func(keys []map[string]any) []map[string]any {
			for _, k := range keys {
				if k["kid"] == "oacp-test-2026-10-a" {
					k["use"] = "enc"
				}
			}
			return keys
		})
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpIssuerKeyUntrusted)
	})

	t.Run("key publishing private material", func(t *testing.T) {
		o := offline()
		o.JWKS = keysWith(t, func(keys []map[string]any) []map[string]any {
			keys[0]["d"] = "AAAA"
			return keys
		})
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpIssuerKeyUntrusted)
	})

	t.Run("off-curve key", func(t *testing.T) {
		o := offline()
		o.JWKS = keysWith(t, func(keys []map[string]any) []map[string]any {
			keys[0]["y"] = oacpB64(bytes.Repeat([]byte{1}, 32))
			return keys
		})
		got := VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o)
		expectOacpRefusal(t, got, OacpIssuerKeyUntrusted)
		if !strings.Contains(got.Message, "cannot be imported") {
			t.Fatalf("message %q", got.Message)
		}
	})

	t.Run("JWKS refetched once for an unknown kid", func(t *testing.T) {
		var calls []bool
		o := offline()
		o.JWKS = nil
		o.JWKSFetcher = func(_ context.Context, refresh bool) (json.RawMessage, error) {
			calls = append(calls, refresh)
			if refresh {
				return f.jwks, nil
			}
			return json.RawMessage(`{"keys":[]}`), nil
		}
		expectOacpValid(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpVerificationStatusNotChecked)
		if len(calls) != 2 || calls[0] || !calls[1] {
			t.Fatalf("calls %v, want [false true]", calls)
		}
	})

	t.Run("JWKS refresh failure keeps the first answer", func(t *testing.T) {
		calls := 0
		o := offline()
		o.JWKSFetcher = func(_ context.Context, refresh bool) (json.RawMessage, error) {
			calls++
			if refresh {
				return nil, errors.New("offline")
			}
			return json.RawMessage(`{"keys":[]}`), nil
		}
		got := VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o)
		expectOacpRefusal(t, got, OacpIssuerKeyUntrusted)
		if calls != 2 || !strings.Contains(got.Message, "no key with kid") {
			t.Fatalf("calls %d message %q", calls, got.Message)
		}
	})

	t.Run("JWKS cannot be loaded", func(t *testing.T) {
		o := offline()
		o.JWKSFetcher = func(context.Context, bool) (json.RawMessage, error) { return nil, errors.New("offline") }
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpIssuerKeyUntrusted)
	})

	t.Run("expired", func(t *testing.T) {
		o := offline()
		o.Now = time.Date(2026, 10, 19, 16, 0, 1, 0, time.UTC)
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpArtifactExpiredOrStale)
	})

	t.Run("valid at the expiry instant", func(t *testing.T) {
		o := offline()
		o.Now = time.Date(2026, 10, 19, 16, 0, 0, 0, time.UTC)
		expectOacpValid(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpVerificationStatusNotChecked)
	})

	t.Run("TTL override", func(t *testing.T) {
		o := offline()
		o.MaxTTLSeconds = map[string]int64{"catalog_snapshot": 60}
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpArtifactTTLExceedsDefault)
	})

	t.Run("scope including an empty buyer", func(t *testing.T) {
		o := offline()
		o.ExpectedScope = &OacpArtifactScope{TenantID: oacpStr("cten_TEST01"), MerchantID: oacpStr("mch_TEST01"), BuyerAgentID: oacpStr("")}
		expectOacpValid(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpVerificationStatusNotChecked)
		o.ExpectedScope = &OacpArtifactScope{SellerAgentID: oacpStr("seller_OTHER")}
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpArtifactScopeMismatch)
		o.ExpectedScope = &OacpArtifactScope{BuyerAgentID: oacpStr("buyer_TEST01")}
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpArtifactScopeMismatch)
	})

	t.Run("non-object inputs", func(t *testing.T) {
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, json.RawMessage(`null`), f.valid.Payload, f.base()), OacpArtifactMissingOrInvalid)
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, nil, f.valid.Payload, f.base()), OacpArtifactMissingOrInvalid)
		got := VerifyOacpArtifact(ctx, f.valid.Envelope, json.RawMessage(`[]`), f.base())
		expectOacpRefusal(t, got, OacpArtifactMissingOrInvalid)
		if got.ArtifactID != "oacp_art_01TESTCATALOG" {
			t.Fatalf("artifact id %q", got.ArtifactID)
		}
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, json.RawMessage(`{"a":1,"a":1}`), f.base()), OacpArtifactMissingOrInvalid)
	})

	t.Run("missing signature", func(t *testing.T) {
		env := strings.Replace(string(f.valid.Envelope), `"signature":`, `"signature_removed":`, 1)
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, json.RawMessage(env), f.valid.Payload, f.base()), OacpSignatureMissingOrPlaceholder)
	})
}

func TestOacpStatusListCheck(t *testing.T) {
	f := loadOacpFixture(t)
	ctx := context.Background()
	withList := func(token func() (string, error)) OacpVerifyOptions {
		o := f.base()
		o.StatusListFetcher = func(_ context.Context, uri string) (string, error) {
			if uri != f.vectors.StatusList.URI {
				t.Errorf("fetched %q", uri)
			}
			return token()
		}
		return o
	}
	tok := func(s string) func() (string, error) { return func() (string, error) { return s, nil } }

	t.Run("VALID", func(t *testing.T) {
		got := VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, withList(tok(f.statusToken(t, 0, statusTokenOptions{}))))
		expectOacpValid(t, got, OacpVerificationStatusValid)
		if got.ArtifactID != "oacp_art_01TESTCATALOG" {
			t.Fatalf("artifact id %q", got.ArtifactID)
		}
	})
	t.Run("RS256-signed list", func(t *testing.T) {
		got := VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, withList(tok(f.statusToken(t, 0, statusTokenOptions{alg: "RS256"}))))
		expectOacpValid(t, got, OacpVerificationStatusValid)
	})
	t.Run("INVALID is revoked", func(t *testing.T) {
		got := VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, withList(tok(f.statusToken(t, 1, statusTokenOptions{}))))
		expectOacpRefusal(t, got, OacpArtifactRevoked)
	})
	t.Run("SUSPENDED is suspended", func(t *testing.T) {
		got := VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, withList(tok(f.statusToken(t, 2, statusTokenOptions{}))))
		expectOacpRefusal(t, got, OacpArtifactSuspended)
	})
	t.Run("unknown status value 3", func(t *testing.T) {
		got := VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, withList(tok(f.statusToken(t, 3, statusTokenOptions{}))))
		expectOacpRefusal(t, got, OacpRevocationStatusUnavailable)
	})
	t.Run("unreachable", func(t *testing.T) {
		got := VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, withList(func() (string, error) { return "", errors.New("connection refused") }))
		expectOacpRefusal(t, got, OacpRevocationStatusUnavailable)
	})
	t.Run("no fetcher", func(t *testing.T) {
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, f.base()), OacpRevocationStatusUnavailable)
	})

	broken := []struct {
		name  string
		token func() string
	}{
		{"signed by a key outside the JWK Set", func() string { return f.statusToken(t, 0, statusTokenOptions{key: f.stranger}) }},
		{"for another list", func() string {
			return f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"sub": "https://issuer.example/status/oacp/lst_OTHER"}})
		}},
		{"from another issuer", func() string {
			return f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"iss": "https://other.example"}})
		}},
		{"expired", func() string {
			return f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"exp": f.nowS - 1}})
		}},
		{"without exp or ttl", func() string {
			return f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"exp": oacpDelete{}, "ttl": oacpDelete{}}})
		}},
		{"older than its ttl", func() string {
			return f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"exp": oacpDelete{}, "iat": f.nowS - 601}})
		}},
		{"with a zero ttl", func() string {
			return f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"ttl": 0}})
		}},
		{"with a fractional iat", func() string {
			return f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"iat": float64(f.nowS) - 0.5}})
		}},
		{"issued in the future", func() string {
			return f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"iat": f.nowS + 3600, "exp": f.nowS + 7200}})
		}},
		{"with the wrong typ", func() string { return f.statusToken(t, 0, statusTokenOptions{header: map[string]any{"typ": "JWT"}}) }},
		{"with crit", func() string {
			return f.statusToken(t, 0, statusTokenOptions{header: map[string]any{"crit": []string{"exp"}}})
		}},
		{"too short for the index", func() string {
			return f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"status_list": map[string]any{"bits": 2, "lst": oacpLst(t, nil, 4, 2)}}})
		}},
		{"with a bad bit width", func() string {
			return f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"status_list": map[string]any{"bits": 3, "lst": oacpLst(t, nil, 64, 2)}}})
		}},
		{"not ZLIB data", func() string {
			return f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"status_list": map[string]any{"bits": 2, "lst": oacpB64([]byte("not zlib"))}}})
		}},
		{"not a JWS", func() string { return "not-a-jws" }},
	}
	for _, b := range broken {
		t.Run("broken list "+b.name, func(t *testing.T) {
			got := VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, withList(tok(b.token())))
			expectOacpRefusal(t, got, OacpRevocationStatusUnavailable)
		})
	}

	t.Run("edited status reference fails the signature first", func(t *testing.T) {
		env := strings.Replace(string(f.valid.Envelope),
			`"revocation_status_url": "https://issuer.example/status/oacp/lst_01TEST"`,
			`"revocation_status_url": "https://issuer.example/status/oacp/lst_OTHER"`, 1)
		if env == string(f.valid.Envelope) {
			t.Fatal("the envelope edit did not apply")
		}
		got := VerifyOacpArtifact(ctx, json.RawMessage(env), f.valid.Payload, withList(tok(f.statusToken(t, 0, statusTokenOptions{}))))
		expectOacpRefusal(t, got, OacpDetachedJWSVerificationFailed)
	})

	t.Run("ReadOacpStatus", func(t *testing.T) {
		status, err := ReadOacpStatus(f.statusToken(t, 2, statusTokenOptions{}), f.vectors.StatusList.URI, f.vectors.StatusList.Idx, f.jwks, oacpTestIssuer, f.now)
		if err != nil || status != OacpTokenStatusSuspended {
			t.Fatalf("status %d err %v", status, err)
		}
		_, err = ReadOacpStatus("not-a-jws", f.vectors.StatusList.URI, 0, f.jwks, oacpTestIssuer, f.now)
		var listErr *OacpStatusListError
		if !errors.As(err, &listErr) {
			t.Fatalf("err %v, want *OacpStatusListError", err)
		}
	})
}

func TestOacpStatusListCodec(t *testing.T) {
	t.Run("LSB-first 2-bit entries", func(t *testing.T) {
		list, err := DecodeOacpStatusList(2, oacpLst(t, map[int]int{0: 1, 1: 2, 5: 1}, 8, 2))
		if err != nil {
			t.Fatal(err)
		}
		want := []int{1, 2, 0, 0, 0, 1, 0, 0}
		for i, w := range want {
			if got, err := list.StatusAt(i); err != nil || got != w {
				t.Fatalf("entry %d: %d %v, want %d", i, got, err, w)
			}
		}
		if _, err := list.StatusAt(8); err == nil {
			t.Fatal("index 8 should be outside the list")
		}
		if _, err := list.StatusAt(-1); err == nil {
			t.Fatal("index -1 should be outside the list")
		}
	})

	t.Run("draft 1-bit example", func(t *testing.T) {
		// §4.1 example: statuses 1,0,0,1,1,1,0,1 / 1,1,0,0,0,1,0,1 -> bytes 0xB9 0xA3.
		list, err := DecodeOacpStatusList(1, oacpDeflate(t, []byte{0xB9, 0xA3}))
		if err != nil {
			t.Fatal(err)
		}
		want := []int{1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1}
		if list.Size() != 16 {
			t.Fatalf("size %d", list.Size())
		}
		for i, w := range want {
			if got, _ := list.StatusAt(i); got != w {
				t.Fatalf("entry %d: %d, want %d", i, got, w)
			}
		}
	})

	t.Run("4- and 8-bit entries", func(t *testing.T) {
		l4, err := DecodeOacpStatusList(4, oacpDeflate(t, []byte{0x21}))
		if err != nil {
			t.Fatal(err)
		}
		if a, _ := l4.StatusAt(0); a != 1 {
			t.Fatalf("4-bit entry 0 = %d", a)
		}
		if b, _ := l4.StatusAt(1); b != 2 {
			t.Fatalf("4-bit entry 1 = %d", b)
		}
		l8, err := DecodeOacpStatusList(8, oacpDeflate(t, []byte{0, 0xFE}))
		if err != nil {
			t.Fatal(err)
		}
		if v, _ := l8.StatusAt(1); v != 0xFE {
			t.Fatalf("8-bit entry 1 = %d", v)
		}
	})

	t.Run("refusals", func(t *testing.T) {
		if _, err := DecodeOacpStatusList(3, oacpDeflate(t, []byte{0})); err == nil {
			t.Fatal("bits 3 accepted")
		}
		if _, err := DecodeOacpStatusList(1, ""); err == nil {
			t.Fatal("empty lst accepted")
		}
		if _, err := DecodeOacpStatusList(1, oacpDeflate(t, []byte{0})+"="); err == nil {
			t.Fatal("padded lst accepted")
		}
		if _, err := DecodeOacpStatusList(1, oacpB64([]byte("not zlib"))); err == nil {
			t.Fatal("non-zlib lst accepted")
		}
		big := oacpDeflate(t, make([]byte, OacpStatusListMaxDecodedBytes+1))
		if _, err := DecodeOacpStatusList(1, big); err == nil || !strings.Contains(err.Error(), "more than") {
			t.Fatalf("oversized list: %v", err)
		}
	})
}

func TestOacpTimestamps(t *testing.T) {
	ok := map[string]int64{
		"2026-10-19T10:00:00Z":           time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC).UnixMilli(),
		"2026-10-19T10:00:00.123456789Z": time.Date(2026, 10, 19, 10, 0, 0, 123e6, time.UTC).UnixMilli(),
		"2026-10-19T12:30:00+02:30":      time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC).UnixMilli(),
		"2028-02-29T00:00:00-01:00":      time.Date(2028, 2, 29, 1, 0, 0, 0, time.UTC).UnixMilli(),
		"0050-01-01T00:00:00Z":           time.Date(1950, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli(),
		"2026-10-19T10:00:00.291Z":       time.Date(2026, 10, 19, 10, 0, 0, 291e6, time.UTC).UnixMilli(),
	}
	for in, want := range ok {
		if got, valid := ParseOacpTimestamp(in); !valid || got != want {
			t.Errorf("%s: %d %v, want %d", in, got, valid, want)
		}
	}
	for _, in := range []string{
		"2026-02-30T00:00:00Z", "2027-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-19T24:00:00Z",
		"2026-10-19T10:00:60Z", "2026-10-19 10:00:00Z", "2026-10-19T10:00:00", "2026-10-19t10:00:00z",
		"2026-10-19T10:00:00+24:00", "2026-10-19T10:00:00.Z", "2026-10-19T10:00:00.1234567890Z",
	} {
		if _, valid := ParseOacpTimestamp(in); valid {
			t.Errorf("%s accepted", in)
		}
	}
}

func TestOacpForbiddenFieldsAndConstants(t *testing.T) {
	for key, want := range map[string]bool{
		"apiKey": true, "API-Key": true, "api key": true, "webhookSecret": true, "raw-jwt": true,
		"merchantPrivateApiKey": true, "tokens": false, "Token": true, "credential_ref": false,
	} {
		_, got := oacpForbiddenPayloadFields[oacpNormalizeKey(key)]
		if got != want {
			t.Errorf("%q -> %q forbidden=%v, want %v", key, oacpNormalizeKey(key), got, want)
		}
	}
	if !oacpHasForbiddenField(mustParseOacp(t, `{"a":[{"b":{"accessToken":"x"}}]}`)) {
		t.Error("nested forbidden field missed")
	}
	if oacpHasForbiddenField(mustParseOacp(t, `{"a":["token"]}`)) {
		t.Error("a string value is not a member name")
	}
	if len(OacpRefusalCodes()) != 13 || OacpRefusalCodes()[0] != OacpArtifactMissingOrInvalid {
		t.Error("refusal codes")
	}
	ttl := OacpArtifactMaxTTLSeconds()
	ttl["offer"] = 1
	if OacpArtifactMaxTTLSeconds()["offer"] != 900 {
		t.Error("OacpArtifactMaxTTLSeconds must return a copy")
	}
	if OacpArtifactMaxTTLSeconds()["revocation"] != 86400 {
		t.Error("revocation artifacts may live 24 hours")
	}
	if len(OacpForbiddenPayloadFields()) != len(oacpForbiddenPayloadFields) {
		t.Error("forbidden fields")
	}
}

func mustParseOacp(t *testing.T, s string) any {
	t.Helper()
	v, err := parseOacpJSON([]byte(s), false)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// ---- fetchers ----

type oacpRoundTrip func(*http.Request) (*http.Response, error)

func (f oacpRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func oacpResponse(status int, contentType, body string) *http.Response {
	h := http.Header{}
	if contentType != "" {
		h.Set("Content-Type", contentType)
	}
	return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(body)), ContentLength: int64(len(body))}
}

func oacpClient(rt oacpRoundTrip) *http.Client { return &http.Client{Transport: rt} }

func TestOacpStatusListFetcher(t *testing.T) {
	f := loadOacpFixture(t)
	ctx := context.Background()
	prefixes := []string{"https://issuer.example/status/oacp/"}

	t.Run("refuses URIs outside the prefixes, http and queries", func(t *testing.T) {
		fetcher, err := NewOacpStatusListFetcher(OacpStatusListFetcherOptions{
			AllowedPrefixes: prefixes,
			HTTPClient: oacpClient(func(*http.Request) (*http.Response, error) {
				t.Error("no request expected")
				return oacpResponse(200, OacpStatusListTokenMediaType, "x"), nil
			}),
		})
		if err != nil {
			t.Fatal(err)
		}
		for uri, want := range map[string]string{
			"https://attacker.example/status/oacp/lst_01TEST":          "outside",
			"https://issuer.example/status/other/lst_01TEST":           "outside",
			"http://issuer.example/status/oacp/lst_01TEST":             "https",
			"https://issuer.example/status/oacp/lst_01TEST?x=1":        "query",
			"https://issuer.example/status/oacp/lst_01TEST#frag":       "fragment",
			"https://user:pw@issuer.example/status/oacp/lst_01TEST":    "credentials",
			"https://issuer.example/status/oacp/../../admin/lst":       "dot segments",
			"https://issuer.example/status/oacp/%2e%2E/lst":            "dot segments",
			"https://issuer.example/status/oacp/%2e%2e%2f%2e%2e%2fadm": "dot segments",
			"https://issuer.example/status/oacp/./lst_01TEST":          "dot segments",
		} {
			if _, err := fetcher.Fetch(ctx, uri); err == nil || !strings.Contains(err.Error(), want) {
				t.Errorf("%s: err %v, want it to mention %q", uri, err, want)
			}
		}
	})

	t.Run("needs a prefix and https prefixes", func(t *testing.T) {
		if _, err := NewOacpStatusListFetcher(OacpStatusListFetcherOptions{}); err == nil {
			t.Error("no prefixes accepted")
		}
		if _, err := NewOacpStatusListFetcher(OacpStatusListFetcherOptions{AllowedPrefixes: []string{"http://issuer.example/"}}); err == nil {
			t.Error("http prefix accepted")
		}
		if _, err := NewOacpStatusListFetcher(OacpStatusListFetcherOptions{AllowedPrefixes: []string{"http://127.0.0.1:3001/status/"}, AllowLoopbackHTTP: true}); err != nil {
			t.Errorf("loopback http prefix refused: %v", err)
		}
	})

	t.Run("302 is refused, not followed", func(t *testing.T) {
		calls := 0
		fetcher, _ := NewOacpStatusListFetcher(OacpStatusListFetcherOptions{
			AllowedPrefixes: prefixes,
			HTTPClient: oacpClient(func(r *http.Request) (*http.Response, error) {
				calls++
				resp := oacpResponse(302, "", "")
				resp.Header.Set("Location", "https://issuer.example/status/oacp/lst_MOVED")
				resp.Request = r
				return resp, nil
			}),
		})
		if _, err := fetcher.Fetch(ctx, f.vectors.StatusList.URI); err == nil || !strings.Contains(err.Error(), "302") {
			t.Fatalf("err %v", err)
		}
		if calls != 1 {
			t.Fatalf("%d requests, want 1", calls)
		}
	})

	t.Run("wrong media type", func(t *testing.T) {
		fetcher, _ := NewOacpStatusListFetcher(OacpStatusListFetcherOptions{
			AllowedPrefixes: prefixes,
			HTTPClient: oacpClient(func(*http.Request) (*http.Response, error) {
				return oacpResponse(200, "application/json", "{}"), nil
			}),
		})
		if _, err := fetcher.Fetch(ctx, f.vectors.StatusList.URI); err == nil || !strings.Contains(err.Error(), "content type") {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("body larger than the limit", func(t *testing.T) {
		fetcher, _ := NewOacpStatusListFetcher(OacpStatusListFetcherOptions{
			AllowedPrefixes: prefixes,
			HTTPClient: oacpClient(func(*http.Request) (*http.Response, error) {
				resp := oacpResponse(200, OacpStatusListTokenMediaType, strings.Repeat("a", OacpStatusListMaxBytes+1))
				resp.ContentLength = -1
				return resp, nil
			}),
		})
		if _, err := fetcher.Fetch(ctx, f.vectors.StatusList.URI); err == nil || !strings.Contains(err.Error(), "larger") {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("ttl caching and Clear", func(t *testing.T) {
		calls := 0
		token := f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"exp": time.Now().Unix() + 3600}})
		fetcher, _ := NewOacpStatusListFetcher(OacpStatusListFetcherOptions{
			AllowedPrefixes: prefixes,
			HTTPClient: oacpClient(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Header.Get("Accept") == "" {
					t.Error("no Accept header")
				}
				return oacpResponse(200, "application/statuslist+jwt; charset=utf-8", token+"\n"), nil
			}),
		})
		for i := 0; i < 2; i++ {
			got, err := fetcher.Fetch(ctx, f.vectors.StatusList.URI)
			if err != nil || got != token {
				t.Fatalf("fetch %d: %v", i, err)
			}
		}
		if calls != 1 {
			t.Fatalf("%d requests, want 1", calls)
		}
		fetcher.Clear()
		if _, err := fetcher.Fetch(ctx, f.vectors.StatusList.URI); err != nil {
			t.Fatal(err)
		}
		if calls != 2 {
			t.Fatalf("%d requests after Clear, want 2", calls)
		}
		// The cache never outlives the list's ttl.
		fetcher.now = func() time.Time { return time.Now().Add(601 * time.Second) }
		if _, err := fetcher.Fetch(ctx, f.vectors.StatusList.URI); err != nil {
			t.Fatal(err)
		}
		if calls != 3 {
			t.Fatalf("%d requests after the ttl, want 3", calls)
		}
	})

	t.Run("MaxCacheSeconds 0 disables reuse", func(t *testing.T) {
		calls := 0
		zero := 0
		token := f.statusToken(t, 0, statusTokenOptions{claims: map[string]any{"exp": time.Now().Unix() + 3600}})
		fetcher, _ := NewOacpStatusListFetcher(OacpStatusListFetcherOptions{
			AllowedPrefixes: prefixes,
			MaxCacheSeconds: &zero,
			HTTPClient: oacpClient(func(*http.Request) (*http.Response, error) {
				calls++
				return oacpResponse(200, OacpStatusListTokenMediaType, token), nil
			}),
		})
		_, _ = fetcher.Fetch(ctx, f.vectors.StatusList.URI)
		_, _ = fetcher.Fetch(ctx, f.vectors.StatusList.URI)
		if calls != 2 {
			t.Fatalf("%d requests, want 2", calls)
		}
	})

	t.Run("TLS server end to end", func(t *testing.T) {
		token := f.statusToken(t, 0, statusTokenOptions{})
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/status/oacp/lst_01TEST":
				w.Header().Set("Content-Type", OacpStatusListTokenMediaType)
				_, _ = io.WriteString(w, token)
			case "/status/oacp/moved":
				http.Redirect(w, r, "/status/oacp/lst_01TEST", http.StatusFound)
			default:
				http.NotFound(w, r)
			}
		}))
		defer srv.Close()
		fetcher, err := NewOacpStatusListFetcher(OacpStatusListFetcherOptions{
			AllowedPrefixes: []string{srv.URL + "/status/oacp/"},
			HTTPClient:      srv.Client(),
		})
		if err != nil {
			t.Fatal(err)
		}
		got, err := fetcher.Fetch(ctx, srv.URL+"/status/oacp/lst_01TEST")
		if err != nil || got != token {
			t.Fatalf("fetch: %v", err)
		}
		if _, err := fetcher.Fetch(ctx, srv.URL+"/status/oacp/moved"); err == nil || !strings.Contains(err.Error(), "302") {
			t.Fatalf("redirect: %v", err)
		}
		if _, err := fetcher.Fetch(ctx, srv.URL+"/status/oacp/missing"); err == nil || !strings.Contains(err.Error(), "404") {
			t.Fatalf("404: %v", err)
		}
	})

	t.Run("fetcher feeds the verifier", func(t *testing.T) {
		token := f.statusToken(t, 1, statusTokenOptions{})
		fetcher, _ := NewOacpStatusListFetcher(OacpStatusListFetcherOptions{
			AllowedPrefixes: prefixes,
			HTTPClient: oacpClient(func(*http.Request) (*http.Response, error) {
				return oacpResponse(200, OacpStatusListTokenMediaType, token), nil
			}),
		})
		o := f.base()
		o.StatusListFetcher = fetcher.Fetch
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpArtifactRevoked)
	})
}

func TestOacpJWKSFetcher(t *testing.T) {
	f := loadOacpFixture(t)
	ctx := context.Background()

	t.Run("reads the pinned JWKS URI and caches it", func(t *testing.T) {
		var urls []string
		jwks, err := NewOacpJWKSFetcher(oacpTestIssuer, OacpJWKSFetcherOptions{
			HTTPClient: oacpClient(func(r *http.Request) (*http.Response, error) {
				urls = append(urls, r.URL.String())
				return oacpResponse(200, "application/json", string(f.jwks)), nil
			}),
		})
		if err != nil {
			t.Fatal(err)
		}
		o := f.base()
		o.JWKS = nil
		o.JWKSFetcher = jwks
		o.SkipStatusCheck = true
		expectOacpValid(t, VerifyOacpArtifact(ctx, f.valid.Envelope, f.valid.Payload, o), OacpVerificationStatusNotChecked)
		if _, err := jwks(ctx, false); err != nil {
			t.Fatal(err)
		}
		if len(urls) != 1 || urls[0] != "https://issuer.example/.well-known/jwks.json" {
			t.Fatalf("urls %v", urls)
		}
	})

	t.Run("refresh honours the cooldown", func(t *testing.T) {
		calls := 0
		clock := time.Date(2026, 10, 19, 11, 0, 0, 0, time.UTC)
		jwks, err := newOacpJWKSFetcher("https://issuer.example/", OacpJWKSFetcherOptions{
			HTTPClient: oacpClient(func(*http.Request) (*http.Response, error) {
				calls++
				return oacpResponse(200, "application/jwk-set+json", string(f.jwks)), nil
			}),
		}, func() time.Time { return clock })
		if err != nil {
			t.Fatal(err)
		}
		_, _ = jwks(ctx, false)
		_, _ = jwks(ctx, true) // within 30 s: served from the cache
		if calls != 1 {
			t.Fatalf("%d fetches, want 1", calls)
		}
		clock = clock.Add(31 * time.Second)
		_, _ = jwks(ctx, false)
		if calls != 1 {
			t.Fatalf("%d fetches, want 1", calls)
		}
		_, _ = jwks(ctx, true)
		if calls != 2 {
			t.Fatalf("%d fetches after the cooldown, want 2", calls)
		}
		clock = clock.Add(11 * time.Minute)
		_, _ = jwks(ctx, false)
		if calls != 3 {
			t.Fatalf("%d fetches after expiry, want 3", calls)
		}
	})

	t.Run("refuses a response that is not a JWK Set", func(t *testing.T) {
		for _, c := range []struct{ ct, body, want string }{
			{"application/json", `{"nokeys":[]}`, "not a JWK Set"},
			{"text/html", string(f.jwks), "content type"},
			{"application/json", strings.Repeat(" ", OacpJWKSMaxBytes+1), "larger"},
		} {
			jwks, _ := NewOacpJWKSFetcher(oacpTestIssuer, OacpJWKSFetcherOptions{
				HTTPClient: oacpClient(func(*http.Request) (*http.Response, error) {
					return oacpResponse(200, c.ct, c.body), nil
				}),
			})
			if _, err := jwks(ctx, false); err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("%s: err %v, want %q", c.ct, err, c.want)
			}
		}
	})

	t.Run("explicit JWKS URI", func(t *testing.T) {
		var got string
		jwks, err := NewOacpJWKSFetcher(oacpTestIssuer, OacpJWKSFetcherOptions{
			JWKSURI: "https://keys.issuer.example/jwks",
			HTTPClient: oacpClient(func(r *http.Request) (*http.Response, error) {
				got = r.URL.String()
				return oacpResponse(200, "application/json", string(f.jwks)), nil
			}),
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := jwks(ctx, false); err != nil || got != "https://keys.issuer.example/jwks" {
			t.Fatalf("url %q err %v", got, err)
		}
	})

	t.Run("http issuer only on loopback when allowed", func(t *testing.T) {
		if _, err := NewOacpJWKSFetcher("http://issuer.example", OacpJWKSFetcherOptions{}); err == nil || !strings.Contains(err.Error(), "https") {
			t.Errorf("http issuer: %v", err)
		}
		if _, err := NewOacpJWKSFetcher("http://127.0.0.1:3001", OacpJWKSFetcherOptions{}); err == nil {
			t.Error("loopback http accepted without AllowLoopbackHTTP")
		}
		if _, err := NewOacpJWKSFetcher("http://127.0.0.1:3001", OacpJWKSFetcherOptions{AllowLoopbackHTTP: true}); err != nil {
			t.Errorf("loopback http refused: %v", err)
		}
		if _, err := NewOacpJWKSFetcher("http://localhost:3001", OacpJWKSFetcherOptions{AllowLoopbackHTTP: true}); err != nil {
			t.Errorf("localhost http refused: %v", err)
		}
	})
}

func TestOacpStatusURIRules(t *testing.T) {
	for uri, want := range map[string]bool{
		"https://issuer.example/status/oacp/lst_01TEST": true,
		"http://issuer.example/status/oacp/lst_01TEST":  false,
		"http://127.0.0.1:3001/status/oacp/lst":         false,
		"ftp://issuer.example/x":                        false,
		"not a url":                                     false,
	} {
		if got := oacpStatusURIAllowed(uri, false); got != want {
			t.Errorf("%s: %v, want %v", uri, got, want)
		}
	}
	if !oacpStatusURIAllowed("http://127.0.0.1:3001/status/oacp/lst", true) || !oacpStatusURIAllowed("http://[::1]:3001/s", true) {
		t.Error("loopback http refused with AllowLoopbackHTTP")
	}
	if oacpStatusURIAllowed("http://127.0.0.1.example/s", true) {
		t.Error("non-loopback host accepted")
	}
}

// resign returns the valid vector envelope and payload after edit, with
// payload_hash and the detached JWS recomputed with the vector test key, so
// the checks after the signature can be reached.
func (f *oacpFixture) resign(t *testing.T, edit func(env, payload map[string]any)) (json.RawMessage, json.RawMessage) {
	t.Helper()
	raw, err := os.ReadFile("../../spec/examples/oacp/oacp-artifact-jws-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Key struct {
			D string `json:"d"`
		} `json:"test_private_jwk"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	d, ok := oacpDecodeBase64urlStrict(doc.Key.D)
	if !ok {
		t.Fatal("test key")
	}
	key, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), d)
	if err != nil {
		t.Fatal(err)
	}
	decode := func(b []byte) map[string]any {
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.UseNumber()
		var m map[string]any
		if err := dec.Decode(&m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	env, payload := decode(f.valid.Envelope), decode(f.valid.Payload)
	edit(env, payload)
	payloadJSON, _ := json.Marshal(payload)
	canonicalPayload, err := canonicalizeOacpJSON(payloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(canonicalPayload)
	env["payload_hash"] = hex.EncodeToString(sum[:])
	delete(env, "signature")
	unsignedJSON, _ := json.Marshal(env)
	canonicalEnv, err := canonicalizeOacpJSON(unsignedJSON)
	if err != nil {
		t.Fatal(err)
	}
	header := oacpB64([]byte(`{"alg":"ES256","kid":"oacp-test-2026-10-a","typ":"oacp-artifact+jws"}`))
	digest := sha256.Sum256([]byte(header + "." + oacpB64(canonicalEnv)))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	env["signature"] = header + ".." + oacpB64(append(oacpPad32(r), oacpPad32(s)...))
	envJSON, _ := json.Marshal(env)
	return envJSON, payloadJSON
}

func TestOacpResignedEnvelopes(t *testing.T) {
	f := loadOacpFixture(t)
	ctx := context.Background()
	fetched := ""
	opts := func() OacpVerifyOptions {
		o := f.base()
		o.StatusListFetcher = func(_ context.Context, uri string) (string, error) {
			fetched = uri
			return f.statusToken(t, 0, statusTokenOptions{}), nil
		}
		return o
	}

	t.Run("unchanged re-signed envelope is valid", func(t *testing.T) {
		env, payload := f.resign(t, func(map[string]any, map[string]any) {})
		expectOacpValid(t, VerifyOacpArtifact(ctx, env, payload, opts()), OacpVerificationStatusValid)
	})

	cases := []struct {
		name string
		edit func(env, payload map[string]any)
		want OacpRefusalCode
	}{
		{"not_before in the future", func(e, _ map[string]any) { e["not_before"] = "2026-10-19T12:00:00Z" }, OacpArtifactNotYetValid},
		{"not_before invalid", func(e, _ map[string]any) { e["not_before"] = nil }, OacpArtifactMissingOrInvalid},
		{"issued_at invalid", func(e, _ map[string]any) { e["issued_at"] = "2026-10-19" }, OacpArtifactMissingOrInvalid},
		{"unknown artifact type", func(e, _ map[string]any) { e["artifact_type"] = "constructor" }, OacpArtifactMissingOrInvalid},
		{"empty artifact id", func(e, _ map[string]any) { e["artifact_id"] = "" }, OacpArtifactMissingOrInvalid},
		{"safety not public", func(e, _ map[string]any) { e["safety"].(map[string]any)["public_safe"] = false }, OacpArtifactMissingOrInvalid},
		{"safety flag as a string", func(e, _ map[string]any) { e["safety"].(map[string]any)["contains_private_data"] = "false" }, OacpArtifactMissingOrInvalid},
		{"forbidden payload field", func(_, p map[string]any) { p["merchantPrivateApiKey"] = "redacted" }, OacpArtifactMissingOrInvalid},
		{"negative lifetime", func(e, _ map[string]any) { e["issued_at"] = "2026-10-19T16:00:01Z" }, OacpArtifactTTLExceedsDefault},
		{"lifetime over the default", func(e, _ map[string]any) { e["expires_at"] = "2026-10-19T16:00:01Z" }, OacpArtifactTTLExceedsDefault},
		{"no status entry", func(e, _ map[string]any) { delete(e, "status") }, OacpRevocationStatusUnavailable},
		{"negative idx", func(e, _ map[string]any) {
			e["status"].(map[string]any)["status_list"].(map[string]any)["idx"] = -1
		}, OacpRevocationStatusUnavailable},
		{"string idx", func(e, _ map[string]any) {
			e["status"].(map[string]any)["status_list"].(map[string]any)["idx"] = "7"
		}, OacpRevocationStatusUnavailable},
		{"fractional idx", func(e, _ map[string]any) {
			e["status"].(map[string]any)["status_list"].(map[string]any)["idx"] = 7.5
		}, OacpRevocationStatusUnavailable},
		{"revocation_status_url differs", func(e, _ map[string]any) {
			e["revocation_status_url"] = "https://issuer.example/status/oacp/lst_OTHER"
		}, OacpRevocationStatusUnavailable},
		{"http status URI", func(e, _ map[string]any) {
			e["revocation_status_url"] = "http://issuer.example/status/oacp/lst_01TEST"
			e["status"].(map[string]any)["status_list"].(map[string]any)["uri"] = "http://issuer.example/status/oacp/lst_01TEST"
		}, OacpRevocationStatusUnavailable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fetched = ""
			env, payload := f.resign(t, c.edit)
			expectOacpRefusal(t, VerifyOacpArtifact(ctx, env, payload, opts()), c.want)
			if fetched != "" {
				t.Fatalf("status list fetched for %s", c.name)
			}
		})
	}

	t.Run("loopback http status URI when allowed", func(t *testing.T) {
		const uri = "http://127.0.0.1:3001/status/oacp/lst_01TEST"
		env, payload := f.resign(t, func(e, _ map[string]any) {
			e["revocation_status_url"] = uri
			e["status"].(map[string]any)["status_list"].(map[string]any)["uri"] = uri
		})
		o := opts()
		o.AllowLoopbackHTTP = true
		// The list's sub names the vector URI, so it is refused after the fetch.
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, env, payload, o), OacpRevocationStatusUnavailable)
		if fetched != uri {
			t.Fatalf("fetched %q", fetched)
		}
	})

	t.Run("payload with a lone surrogate has no canonical form", func(t *testing.T) {
		payload := strings.Replace(string(f.valid.Payload), `"source_system": "shopify"`, `"source_system": "\ud800"`, 1)
		if payload == string(f.valid.Payload) {
			t.Fatal("payload edit did not apply")
		}
		expectOacpRefusal(t, VerifyOacpArtifact(ctx, f.valid.Envelope, json.RawMessage(payload), opts()), OacpArtifactMissingOrInvalid)
	})
}
