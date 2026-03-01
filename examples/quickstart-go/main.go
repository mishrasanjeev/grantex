// Grantex Quickstart — Basic Authorization Flow (Go)
//
// Shows the core Grantex flow using the Go SDK:
//  1. Register an agent
//  2. Authorize in sandbox mode (auto-approved)
//  3. Exchange code for a grant token
//  4. Verify the token offline
//  5. Log an audit entry
//  6. Revoke the token
//
// Prerequisites:
//
//	docker compose up          # from repo root
//	cd examples/quickstart-go
//	go run .
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	grantex "github.com/mishrasanjeev/grantex-go"
)

func main() {
	baseURL := envOr("GRANTEX_URL", "http://localhost:3001")
	apiKey := envOr("GRANTEX_API_KEY", "sandbox-api-key-local")

	client := grantex.NewClient(apiKey, grantex.WithBaseURL(baseURL))
	ctx := context.Background()

	// ── 1. Register an agent ───────────────────────────────────────────
	agent, err := client.Agents.Register(ctx, grantex.RegisterAgentParams{
		Name:        "quickstart-go-agent",
		Description: "Demo agent for the Grantex Go quickstart",
		Scopes:      []string{"calendar:read", "email:send"},
	})
	if err != nil {
		log.Fatal("register agent:", err)
	}
	fmt.Println("Agent registered:", agent.ID, agent.DID)

	// ── 2. Authorize (sandbox mode — auto-approved) ────────────────────
	// In sandbox mode the response includes a `code` field that isn't in the
	// typed struct (it's sandbox-only), so we parse it from the raw JSON.
	code, authRequestID, err := authorizeSandbox(baseURL, apiKey, agent.ID)
	if err != nil {
		log.Fatal("authorize:", err)
	}
	fmt.Println("Auth request:", authRequestID)
	fmt.Println("Sandbox auto-approved, code:", code)

	// ── 3. Exchange code for a grant token ─────────────────────────────
	token, err := client.Tokens.Exchange(ctx, grantex.ExchangeTokenParams{
		Code:    code,
		AgentID: agent.ID,
	})
	if err != nil {
		log.Fatal("exchange:", err)
	}
	fmt.Println("Grant token received, grantId:", token.GrantID)
	fmt.Println("Scopes:", strings.Join(token.Scopes, ", "))

	// ── 4. Verify the token offline ────────────────────────────────────
	verified, err := grantex.VerifyGrantToken(ctx, token.GrantToken, grantex.VerifyGrantTokenParams{
		JWKSURI:        baseURL + "/.well-known/jwks.json",
		RequiredScopes: []string{"calendar:read"},
	})
	if err != nil {
		log.Fatal("verify:", err)
	}
	fmt.Println("Token verified offline:")
	fmt.Println("  principalId:", verified.PrincipalID)
	fmt.Println("  agentDid:   ", verified.AgentDID)
	fmt.Println("  scopes:     ", strings.Join(verified.Scopes, ", "))

	// ── 5. Log an audit entry ──────────────────────────────────────────
	entry, err := client.Audit.Log(ctx, grantex.AuditLogParams{
		AgentID:  agent.ID,
		GrantID:  token.GrantID,
		Action:   "calendar.read",
		Status:   "success",
		Metadata: map[string]interface{}{"query": "today", "results": 3},
	})
	if err != nil {
		log.Fatal("audit:", err)
	}
	fmt.Println("Audit entry logged:", entry.EntryID)

	// ── 6. Revoke the token ────────────────────────────────────────────
	if err := client.Tokens.Revoke(ctx, verified.TokenID); err != nil {
		log.Fatal("revoke:", err)
	}
	fmt.Println("Token revoked.")

	// Verify revocation — online check should now say invalid
	check, err := client.Tokens.Verify(ctx, token.GrantToken)
	if err != nil {
		log.Fatal("verify after revoke:", err)
	}
	if check.Valid {
		fmt.Println("Post-revocation verify: still valid")
	} else {
		fmt.Println("Post-revocation verify: revoked")
	}

	fmt.Println("\nDone! Full authorization lifecycle complete.")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// authorizeSandbox calls POST /v1/authorize and extracts the sandbox-only "code" field.
func authorizeSandbox(baseURL, apiKey, agentID string) (code, authRequestID string, err error) {
	body := map[string]interface{}{
		"agentId":     agentID,
		"principalId": "test-user-001",
		"scopes":      []string{"calendar:read", "email:send"},
	}
	raw, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", baseURL+"/v1/authorize", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", err
	}

	code, _ = result["code"].(string)
	authRequestID, _ = result["authRequestId"].(string)
	if code == "" {
		return "", "", fmt.Errorf("no code returned — are you using the sandbox API key?")
	}
	return code, authRequestID, nil
}
