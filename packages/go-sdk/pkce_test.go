package grantex

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestGeneratePKCE(t *testing.T) {
	pkce, err := GeneratePKCE()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if pkce.CodeChallengeMethod != "S256" {
		t.Errorf("expected S256, got %s", pkce.CodeChallengeMethod)
	}

	if pkce.CodeVerifier == "" {
		t.Error("expected non-empty code verifier")
	}

	if pkce.CodeChallenge == "" {
		t.Error("expected non-empty code challenge")
	}

	// Verify that challenge = base64url(sha256(verifier))
	hash := sha256.Sum256([]byte(pkce.CodeVerifier))
	expectedChallenge := base64.RawURLEncoding.EncodeToString(hash[:])
	if pkce.CodeChallenge != expectedChallenge {
		t.Errorf("challenge mismatch: got %s, expected %s", pkce.CodeChallenge, expectedChallenge)
	}
}

func TestGeneratePKCEUniqueness(t *testing.T) {
	pkce1, err := GeneratePKCE()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	pkce2, err := GeneratePKCE()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if pkce1.CodeVerifier == pkce2.CodeVerifier {
		t.Error("expected different verifiers for successive calls")
	}
	if pkce1.CodeChallenge == pkce2.CodeChallenge {
		t.Error("expected different challenges for successive calls")
	}
}

func TestGeneratePKCEVerifierLength(t *testing.T) {
	pkce, err := GeneratePKCE()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// 32 random bytes -> 43 chars in base64url (no padding)
	if len(pkce.CodeVerifier) != 43 {
		t.Errorf("expected verifier length 43, got %d", len(pkce.CodeVerifier))
	}
}
