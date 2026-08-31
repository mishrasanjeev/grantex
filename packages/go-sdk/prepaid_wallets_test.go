package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func TestAgentPrepaidWalletClientSendsDPoPAndPolicyContext(t *testing.T) {
	var received PrepaidAuthorizationRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "DPoP access-token" {
			t.Fatalf("unexpected authorization: %s", r.Header.Get("Authorization"))
		}
		proof := r.Header.Get("DPoP")
		token, _, err := jwt.NewParser().ParseUnverified(proof, jwt.MapClaims{})
		if err != nil {
			t.Fatalf("invalid DPoP proof: %v", err)
		}
		claims := token.Claims.(jwt.MapClaims)
		if claims["htm"] != "POST" || !strings.HasSuffix(claims["htu"].(string), "/authorizations") || claims["ath"] == "" {
			t.Fatalf("incomplete DPoP claims: %#v", claims)
		}
		if token.Header["typ"] != "dpop+jwt" {
			t.Fatalf("unexpected DPoP typ")
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"approval_required","approvalRequestId":"wapr_1","walletId":"pwal_1","assignmentId":"wasn_1","policyIds":["wspol_1"],"expiresAt":"2026-09-01T00:00:00Z"}`))
	}))
	defer server.Close()
	key, err := GenerateDPoPKey()
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewAgentPrepaidWalletClient("access-token", key, server.URL+"/v1/prepaid-wallets", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.AuthorizePayment(context.Background(), PrepaidAuthorizationRequest{
		WalletID: "pwal_1", Amount: "2500", Asset: "USDC", Network: "grantex:prepaid",
		Recipient: "merchant:one", Resource: "https://merchant.example/pay", Scope: "commerce:pay",
		MaxTimeoutSeconds: 300, IdempotencyKey: "payment-000000000001", MerchantID: "org_merchant",
		Purpose: "software", ProjectID: "project-7", CostCenter: "engineering",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "approval_required" || result.ApprovalRequestID != "wapr_1" {
		t.Fatalf("unexpected result: %#v", result)
	}
	if received.CostCenter != "engineering" || received.MerchantID != "org_merchant" {
		t.Fatalf("context was not preserved: %#v", received)
	}
}

func TestPrincipalAndDeveloperWalletPolicyClients(t *testing.T) {
	var authHeaders []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeaders = append(authHeaders, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/prepaid-wallet-spend-policies") && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"policies":[{"policyId":"wspol_1","name":"Org cap","scopeType":"developer","effect":"limit","status":"active"}]}`))
		case strings.HasSuffix(r.URL.Path, "/prepaid-wallet-payment-approvals"):
			_, _ = w.Write([]byte(`{"approvals":[]}`))
		default:
			_, _ = w.Write([]byte(`{"policyId":"wspol_1","name":"Org cap","scopeType":"developer","effect":"limit","status":"active"}`))
		}
	}))
	defer server.Close()

	developer := NewClient("developer-key", WithBaseURL(server.URL), WithHTTPClient(server.Client()), WithMaxRetries(0))
	policies, err := developer.WalletSpendPolicies.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 1 {
		t.Fatalf("expected one policy")
	}
	principal, err := NewPrincipalPrepaidWalletClient("principal-session", WithBaseURL(server.URL), WithHTTPClient(server.Client()), WithMaxRetries(0))
	if err != nil {
		t.Fatal(err)
	}
	approvals, err := principal.ListPaymentApprovals(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(approvals) != 0 {
		t.Fatalf("expected no approvals")
	}
	if authHeaders[0] != "Bearer developer-key" || authHeaders[1] != "Bearer principal-session" {
		t.Fatalf("wrong auth boundaries: %#v", authHeaders)
	}
}

func TestWalletClientsRejectInsecureRemoteAndCredentialedURLs(t *testing.T) {
	if _, err := NewPrincipalPrepaidWalletClient("principal-session", WithBaseURL("http://api.example")); err == nil || !strings.Contains(err.Error(), "must use HTTPS") {
		t.Fatalf("expected remote HTTP rejection, got %v", err)
	}
	if _, err := NewPrincipalPrepaidWalletClient("principal-session", WithBaseURL("https://user:password@api.example")); err == nil || !strings.Contains(err.Error(), "without credentials") {
		t.Fatalf("expected credential rejection, got %v", err)
	}
	key, err := GenerateDPoPKey()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewAgentPrepaidWalletClient("token", key, "http://api.example/v1/prepaid-wallets"); err == nil || !strings.Contains(err.Error(), "must use HTTPS") {
		t.Fatalf("expected agent remote HTTP rejection, got %v", err)
	}
}
