package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWebAuthnRegisterOptions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webauthn/register/options" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params WebAuthnRegisterOptionsParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.PrincipalID != "user-1" {
			t.Errorf("expected principalId user-1, got %s", params.PrincipalID)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(WebAuthnRegistrationOptions{
			ChallengeID: "challenge-1",
			Options: map[string]interface{}{
				"rp": map[string]interface{}{
					"name": "Grantex",
				},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	opts, err := client.WebAuthn.RegisterOptions(context.Background(), WebAuthnRegisterOptionsParams{
		PrincipalID: "user-1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if opts.ChallengeID != "challenge-1" {
		t.Errorf("expected challenge-1, got %s", opts.ChallengeID)
	}
}

func TestWebAuthnRegisterVerify(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webauthn/register/verify" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(WebAuthnCredential{
			ID:           "cred-1",
			CredentialID: "cred-id-abc",
			PublicKey:    "pk-xyz",
			Counter:      0,
			Transports:   []string{"usb", "ble"},
			CreatedAt:    "2026-03-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	cred, err := client.WebAuthn.RegisterVerify(context.Background(), WebAuthnRegisterVerifyParams{
		ChallengeID: "challenge-1",
		Response:    map[string]string{"attestationObject": "abc"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cred.ID != "cred-1" {
		t.Errorf("expected cred-1, got %s", cred.ID)
	}
	if cred.CredentialID != "cred-id-abc" {
		t.Errorf("expected cred-id-abc, got %s", cred.CredentialID)
	}
}

func TestWebAuthnListCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webauthn/credentials" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("principalId") != "user-1" {
			t.Errorf("expected principalId=user-1, got %s", r.URL.Query().Get("principalId"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(listWebAuthnCredentialsResponse{
			Credentials: []WebAuthnCredential{
				{ID: "cred-1", CredentialID: "cred-id-1"},
				{ID: "cred-2", CredentialID: "cred-id-2"},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	creds, err := client.WebAuthn.ListCredentials(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(creds) != 2 {
		t.Errorf("expected 2 credentials, got %d", len(creds))
	}
}

func TestWebAuthnDeleteCredential(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webauthn/credentials/cred-1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.WebAuthn.DeleteCredential(context.Background(), "cred-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
