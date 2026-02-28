package grantex

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
)

// PKCEChallenge holds a PKCE code verifier and its S256 challenge.
type PKCEChallenge struct {
	CodeVerifier        string
	CodeChallenge       string
	CodeChallengeMethod string // Always "S256"
}

// GeneratePKCE creates a new PKCE code verifier and S256 challenge pair.
func GeneratePKCE() (*PKCEChallenge, error) {
	// Generate 32 random bytes for the verifier
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, &NetworkError{Message: "failed to generate random bytes", Cause: err}
	}

	verifier := base64.RawURLEncoding.EncodeToString(buf)

	// S256: SHA-256 hash of the verifier, base64url-encoded
	hash := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(hash[:])

	return &PKCEChallenge{
		CodeVerifier:        verifier,
		CodeChallenge:       challenge,
		CodeChallengeMethod: "S256",
	}, nil
}
