package grantex

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/lestrrat-go/jwx/v2/jwk"
)

func publicJWK(t *testing.T, raw interface{}, kid, alg string) map[string]interface{} {
	t.Helper()
	key, err := jwk.FromRaw(raw)
	if err != nil {
		t.Fatalf("jwk.FromRaw: %v", err)
	}
	encoded, err := json.Marshal(key)
	if err != nil {
		t.Fatalf("marshal jwk: %v", err)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatalf("unmarshal jwk: %v", err)
	}
	out["kid"] = kid
	out["use"] = "sig"
	if alg != "" {
		out["alg"] = alg
	}
	return out
}

func serveKeys(t *testing.T, keys ...map[string]interface{}) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"keys": keys})
	}))
	t.Cleanup(server.Close)
	return server
}

func generateECKey(t *testing.T, curve elliptic.Curve) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		t.Fatalf("generate EC key: %v", err)
	}
	return key
}

func grantClaims(iss string) jwt.MapClaims {
	now := time.Now()
	return jwt.MapClaims{
		"iss": iss, "sub": "user-alg", "agt": "did:grantex:agent-alg", "dev": "dev-alg",
		"scp": []string{"calendar:read"}, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
		"jti": "tok-alg", "grnt": "grnt-alg",
	}
}

func sign(t *testing.T, method jwt.SigningMethod, key interface{}, kid, iss string) string {
	t.Helper()
	token := jwt.NewWithClaims(method, grantClaims(iss))
	token.Header["kid"] = kid
	token.Header["typ"] = "at+jwt"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

func withHeader(t *testing.T, token string, header map[string]interface{}) string {
	t.Helper()
	parts := strings.Split(token, ".")
	encoded, err := json.Marshal(header)
	if err != nil {
		t.Fatalf("marshal header: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded) + "." + parts[1] + "." + parts[2]
}

func expectRejected(t *testing.T, token string, opts VerifyOptions) {
	t.Helper()
	grant, err := VerifyGrantToken(context.Background(), token, opts)
	if err == nil {
		t.Fatalf("expected rejection, got grant %+v", grant)
	}
	if _, ok := err.(*TokenError); !ok {
		t.Fatalf("expected *TokenError, got %T: %v", err, err)
	}
}

func TestGrantTokenAlgorithmsAreRS256AndES256(t *testing.T) {
	if got := GrantTokenAlgorithms(); !reflect.DeepEqual(got, []string{"RS256", "ES256"}) {
		t.Fatalf("GrantTokenAlgorithms() = %v", got)
	}
	GrantTokenAlgorithms()[0] = "HS256"
	if GrantTokenAlgorithms()[0] != "RS256" {
		t.Fatal("GrantTokenAlgorithms must return a copy")
	}
}

func TestVerifyGrantTokenES256FromMixedJWKS(t *testing.T) {
	rsaKey := generateTestKey(t)
	ecKey := generateECKey(t, elliptic.P256())
	server := serveKeys(t, publicJWK(t, &rsaKey.PublicKey, "rsa-1", "RS256"), publicJWK(t, &ecKey.PublicKey, "ec-1", "ES256"))

	grant, err := VerifyGrantToken(context.Background(), sign(t, jwt.SigningMethodES256, ecKey, "ec-1", server.URL), VerifyOptions{JwksURI: server.URL})
	if err != nil {
		t.Fatalf("ES256 verify: %v", err)
	}
	if grant.GrantID != "grnt-alg" || grant.AgentDID != "did:grantex:agent-alg" {
		t.Fatalf("unexpected grant: %+v", grant)
	}
	if _, err := VerifyGrantToken(context.Background(), sign(t, jwt.SigningMethodRS256, rsaKey, "rsa-1", server.URL), VerifyOptions{JwksURI: server.URL}); err != nil {
		t.Fatalf("RS256 verify: %v", err)
	}
}

func TestVerifyGrantTokenRejectsKeyTypeConfusion(t *testing.T) {
	rsaKey := generateTestKey(t)
	ecKey := generateECKey(t, elliptic.P256())
	server := serveKeys(t, publicJWK(t, &rsaKey.PublicKey, "rsa-1", "RS256"), publicJWK(t, &ecKey.PublicKey, "ec-1", "ES256"))
	opts := VerifyOptions{JwksURI: server.URL}

	// ES256 token naming the RSA key, RS256 token naming the EC key.
	expectRejected(t, sign(t, jwt.SigningMethodES256, ecKey, "rsa-1", server.URL), opts)
	expectRejected(t, sign(t, jwt.SigningMethodRS256, rsaKey, "ec-1", server.URL), opts)
}

func TestVerifyGrantTokenRejectsAlgHeaderTampering(t *testing.T) {
	rsaKey := generateTestKey(t)
	ecKey := generateECKey(t, elliptic.P256())
	server := serveKeys(t, publicJWK(t, &rsaKey.PublicKey, "rsa-1", "RS256"), publicJWK(t, &ecKey.PublicKey, "ec-1", "ES256"))
	opts := VerifyOptions{JwksURI: server.URL}

	rs := sign(t, jwt.SigningMethodRS256, rsaKey, "rsa-1", server.URL)
	expectRejected(t, withHeader(t, rs, map[string]interface{}{"alg": "ES256", "kid": "rsa-1", "typ": "at+jwt"}), opts)
	expectRejected(t, withHeader(t, rs, map[string]interface{}{"alg": "ES256", "kid": "ec-1", "typ": "at+jwt"}), opts)

	es := sign(t, jwt.SigningMethodES256, ecKey, "ec-1", server.URL)
	expectRejected(t, withHeader(t, es, map[string]interface{}{"alg": "RS256", "kid": "ec-1", "typ": "at+jwt"}), opts)
}

func TestVerifyGrantTokenRejectsKeyPublishedForAnotherAlgorithm(t *testing.T) {
	ecKey := generateECKey(t, elliptic.P256())
	server := serveKeys(t, publicJWK(t, &ecKey.PublicKey, "ec-1", "RS256"))
	expectRejected(t, sign(t, jwt.SigningMethodES256, ecKey, "ec-1", server.URL), VerifyOptions{JwksURI: server.URL})
}

func TestVerifyGrantTokenRejectsNonSignatureKey(t *testing.T) {
	ecKey := generateECKey(t, elliptic.P256())
	encKey := publicJWK(t, &ecKey.PublicKey, "ec-1", "ES256")
	encKey["use"] = "enc"
	server := serveKeys(t, encKey)
	expectRejected(t, sign(t, jwt.SigningMethodES256, ecKey, "ec-1", server.URL), VerifyOptions{JwksURI: server.URL})
}

func TestVerifyGrantTokenES256RequiresP256(t *testing.T) {
	signer := generateECKey(t, elliptic.P256())
	p384 := generateECKey(t, elliptic.P384())
	server := serveKeys(t, publicJWK(t, &p384.PublicKey, "ec-1", ""))
	expectRejected(t, sign(t, jwt.SigningMethodES256, signer, "ec-1", server.URL), VerifyOptions{JwksURI: server.URL})
}

func TestVerifyGrantTokenRejectsHS256WithPublicKeyMaterial(t *testing.T) {
	rsaKey := generateTestKey(t)
	server := serveKeys(t, publicJWK(t, &rsaKey.PublicKey, "rsa-1", "RS256"))
	der, err := x509.MarshalPKIXPublicKey(&rsaKey.PublicKey)
	if err != nil {
		t.Fatalf("marshal public key: %v", err)
	}
	secret := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	expectRejected(t, sign(t, jwt.SigningMethodHS256, secret, "rsa-1", server.URL), VerifyOptions{JwksURI: server.URL})
}

func TestVerifyGrantTokenRejectsAlgNone(t *testing.T) {
	rsaKey := generateTestKey(t)
	server := serveKeys(t, publicJWK(t, &rsaKey.PublicKey, "rsa-1", "RS256"))
	token := jwt.NewWithClaims(jwt.SigningMethodNone, grantClaims(server.URL))
	token.Header["kid"] = "rsa-1"
	unsigned, err := token.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("sign none: %v", err)
	}
	expectRejected(t, unsigned, VerifyOptions{JwksURI: server.URL})
}

func TestVerifyGrantTokenAlgorithmsOptionNarrowsButNeverWidens(t *testing.T) {
	rsaKey := generateTestKey(t)
	ecKey := generateECKey(t, elliptic.P256())
	server := serveKeys(t, publicJWK(t, &rsaKey.PublicKey, "rsa-1", "RS256"), publicJWK(t, &ecKey.PublicKey, "ec-1", "ES256"))
	es := sign(t, jwt.SigningMethodES256, ecKey, "ec-1", server.URL)

	expectRejected(t, es, VerifyOptions{JwksURI: server.URL, Algorithms: []string{"RS256"}})
	if _, err := VerifyGrantToken(context.Background(), es, VerifyOptions{JwksURI: server.URL, Algorithms: []string{"ES256"}}); err != nil {
		t.Fatalf("ES256 with Algorithms=[ES256]: %v", err)
	}
	for _, alg := range []string{"HS256", "none", "PS256", "EdDSA"} {
		_, err := VerifyGrantToken(context.Background(), es, VerifyOptions{JwksURI: server.URL, Algorithms: []string{"ES256", alg}})
		tokenErr, ok := err.(*TokenError)
		if !ok || !strings.Contains(tokenErr.Message, "unsupported grant token algorithm") {
			t.Fatalf("Algorithms containing %s: got %v", alg, err)
		}
	}
}
