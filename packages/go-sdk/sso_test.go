package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// --- Enterprise SSO Connection Tests ---

func TestSSOCreateConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/connections" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params CreateSsoConnectionParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.Name != "Okta Production" {
			t.Errorf("expected name 'Okta Production', got %s", params.Name)
		}
		if params.Protocol != "oidc" {
			t.Errorf("expected protocol 'oidc', got %s", params.Protocol)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoConnection{
			ID:          "sso-conn-1",
			DeveloperID: "dev-1",
			Name:        "Okta Production",
			Protocol:    "oidc",
			Status:      "active",
			IssuerURL:   "https://dev-12345.okta.com",
			ClientID:    "okta-client-123",
			Domains:     []string{"acme.com"},
			CreatedAt:   "2026-03-29T00:00:00Z",
			UpdatedAt:   "2026-03-29T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	conn, err := client.SSO.CreateConnection(context.Background(), CreateSsoConnectionParams{
		Name:      "Okta Production",
		Protocol:  "oidc",
		IssuerURL: "https://dev-12345.okta.com",
		ClientID:  "okta-client-123",
		Domains:   []string{"acme.com"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if conn.ID != "sso-conn-1" {
		t.Errorf("expected id sso-conn-1, got %s", conn.ID)
	}
	if conn.Name != "Okta Production" {
		t.Errorf("expected name 'Okta Production', got %s", conn.Name)
	}
	if conn.Protocol != "oidc" {
		t.Errorf("expected protocol oidc, got %s", conn.Protocol)
	}
	if conn.Status != "active" {
		t.Errorf("expected status active, got %s", conn.Status)
	}
}

func TestSSOListConnections(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/connections" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListSsoConnectionsResponse{
			Connections: []SsoConnection{
				{ID: "sso-conn-1", Name: "Okta", Protocol: "oidc", Status: "active"},
				{ID: "sso-conn-2", Name: "Azure AD", Protocol: "saml", Status: "inactive"},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.ListConnections(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Connections) != 2 {
		t.Fatalf("expected 2 connections, got %d", len(result.Connections))
	}
	if result.Connections[0].Name != "Okta" {
		t.Errorf("expected first connection name 'Okta', got %s", result.Connections[0].Name)
	}
	if result.Connections[1].Protocol != "saml" {
		t.Errorf("expected second connection protocol 'saml', got %s", result.Connections[1].Protocol)
	}
}

func TestSSOGetConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/connections/sso-conn-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoConnection{
			ID:              "sso-conn-1",
			DeveloperID:     "dev-1",
			Name:            "Okta Production",
			Protocol:        "oidc",
			Status:          "active",
			IssuerURL:       "https://dev-12345.okta.com",
			ClientID:        "okta-client-123",
			Domains:         []string{"acme.com"},
			JitProvisioning: true,
			GroupMappings:   map[string][]string{"admins": {"admin", "owner"}},
			DefaultScopes:   []string{"read", "write"},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	conn, err := client.SSO.GetConnection(context.Background(), "sso-conn-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if conn.ID != "sso-conn-1" {
		t.Errorf("expected id sso-conn-1, got %s", conn.ID)
	}
	if !conn.JitProvisioning {
		t.Error("expected jitProvisioning to be true")
	}
	if len(conn.GroupMappings["admins"]) != 2 {
		t.Errorf("expected 2 admin group mappings, got %d", len(conn.GroupMappings["admins"]))
	}
	if len(conn.DefaultScopes) != 2 {
		t.Errorf("expected 2 default scopes, got %d", len(conn.DefaultScopes))
	}
}

func TestSSOUpdateConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/connections/sso-conn-1" || r.Method != http.MethodPatch {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params UpdateSsoConnectionParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.Name == nil || *params.Name != "Okta Production (Updated)" {
			t.Errorf("expected updated name")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoConnection{
			ID:       "sso-conn-1",
			Name:     "Okta Production (Updated)",
			Protocol: "oidc",
			Status:   "active",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	name := "Okta Production (Updated)"
	conn, err := client.SSO.UpdateConnection(context.Background(), "sso-conn-1", UpdateSsoConnectionParams{
		Name: &name,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if conn.Name != "Okta Production (Updated)" {
		t.Errorf("expected updated name, got %s", conn.Name)
	}
}

func TestSSODeleteConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/connections/sso-conn-1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.SSO.DeleteConnection(context.Background(), "sso-conn-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSSOTestConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/connections/sso-conn-1/test" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoConnectionTestResult{
			Success:  true,
			Protocol: "oidc",
			Issuer:   "https://dev-12345.okta.com",
			Details:  []string{"Discovery document fetched", "JWKS endpoint reachable"},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.TestConnection(context.Background(), "sso-conn-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Success {
		t.Error("expected test to succeed")
	}
	if result.Protocol != "oidc" {
		t.Errorf("expected protocol oidc, got %s", result.Protocol)
	}
	if len(result.Details) != 2 {
		t.Errorf("expected 2 details, got %d", len(result.Details))
	}
}

func TestSSOTestConnectionFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoConnectionTestResult{
			Success:  false,
			Protocol: "saml",
			Error:    "IdP certificate expired",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.TestConnection(context.Background(), "sso-conn-2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Success {
		t.Error("expected test to fail")
	}
	if result.Error != "IdP certificate expired" {
		t.Errorf("expected error message about certificate, got %s", result.Error)
	}
}

// --- SSO Enforcement Tests ---

func TestSSOSetEnforcement(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/enforce" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params SsoEnforcementParams
		json.NewDecoder(r.Body).Decode(&params)
		if !params.Enforce {
			t.Error("expected enforce to be true")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoEnforcementResponse{
			Enforce:     true,
			DeveloperID: "dev-1",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.SetEnforcement(context.Background(), SsoEnforcementParams{
		Enforce: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Enforce {
		t.Error("expected enforce to be true")
	}
	if result.DeveloperID != "dev-1" {
		t.Errorf("expected developerId dev-1, got %s", result.DeveloperID)
	}
}

// --- SSO Session Tests ---

func TestSSOListSessions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/sessions" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListSsoSessionsResponse{
			Sessions: []SsoSession{
				{
					ID:           "sess-1",
					DeveloperID:  "dev-1",
					ConnectionID: "sso-conn-1",
					Email:        "alice@acme.com",
					ExpiresAt:    "2026-03-30T00:00:00Z",
					CreatedAt:    "2026-03-29T00:00:00Z",
				},
				{
					ID:           "sess-2",
					DeveloperID:  "dev-2",
					ConnectionID: "sso-conn-1",
					Email:        "bob@acme.com",
					ExpiresAt:    "2026-03-30T00:00:00Z",
					CreatedAt:    "2026-03-29T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.ListSessions(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(result.Sessions))
	}
	if result.Sessions[0].Email != "alice@acme.com" {
		t.Errorf("expected alice@acme.com, got %s", result.Sessions[0].Email)
	}
	if result.Sessions[1].ID != "sess-2" {
		t.Errorf("expected sess-2, got %s", result.Sessions[1].ID)
	}
}

func TestSSORevokeSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/sessions/sess-1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.SSO.RevokeSession(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- Login Flow Tests ---

func TestSSOGetLoginURLWithDomain(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sso/login" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("org") != "acme-corp" {
			t.Errorf("expected org=acme-corp, got %s", r.URL.Query().Get("org"))
		}
		if r.URL.Query().Get("domain") != "acme.com" {
			t.Errorf("expected domain=acme.com, got %s", r.URL.Query().Get("domain"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoLoginResponse{
			AuthorizeURL: "https://dev-12345.okta.com/authorize?client_id=123",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.GetLoginURL(context.Background(), "acme-corp", "acme.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.AuthorizeURL == "" {
		t.Error("expected authorize URL")
	}
}

func TestSSOGetLoginURLWithoutDomain(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("org") != "acme-corp" {
			t.Errorf("expected org=acme-corp, got %s", r.URL.Query().Get("org"))
		}
		if r.URL.Query().Get("domain") != "" {
			t.Errorf("expected no domain param, got %s", r.URL.Query().Get("domain"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoLoginResponse{
			AuthorizeURL: "https://accounts.google.com/authorize?client_id=123",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.GetLoginURL(context.Background(), "acme-corp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.AuthorizeURL == "" {
		t.Error("expected authorize URL")
	}
}

func TestSSOHandleOidcCallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sso/callback/oidc" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params SsoOidcCallbackParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.Code != "auth-code-123" {
			t.Errorf("expected code auth-code-123, got %s", params.Code)
		}
		if params.State != "state-abc" {
			t.Errorf("expected state state-abc, got %s", params.State)
		}
		if params.RedirectURI != "https://app.example.com/callback" {
			t.Errorf("expected redirect URI, got %s", params.RedirectURI)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"email":        "alice@acme.com",
			"name":         "Alice Smith",
			"sub":          "okta-sub-123",
			"developerId":  "dev-1",
			"groups":       []string{"engineering", "admins"},
			"mappedScopes": []string{"read", "admin"},
			"principalId":  "prn-1",
			"sessionId":    "sess-1",
			"expiresAt":    "2026-03-30T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.HandleOidcCallback(context.Background(), SsoOidcCallbackParams{
		Code:        "auth-code-123",
		State:       "state-abc",
		RedirectURI: "https://app.example.com/callback",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Email == nil || *result.Email != "alice@acme.com" {
		t.Errorf("expected alice@acme.com, got %v", result.Email)
	}
	if len(result.Groups) != 2 {
		t.Errorf("expected 2 groups, got %d", len(result.Groups))
	}
	if result.SessionID != "sess-1" {
		t.Errorf("expected sessionId sess-1, got %s", result.SessionID)
	}
	if len(result.MappedScopes) != 2 || result.PrincipalID == nil || *result.PrincipalID != "prn-1" {
		t.Errorf("unexpected callback authorization data: scopes=%v principal=%v", result.MappedScopes, result.PrincipalID)
	}
	if result.ExpiresAt != "2026-03-30T00:00:00Z" {
		t.Errorf("unexpected expiresAt: %s", result.ExpiresAt)
	}
}

func TestSSOHandleSamlCallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sso/callback/saml" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params map[string]string
		json.NewDecoder(r.Body).Decode(&params)
		if params["SAMLResponse"] != "PHNhbWw+..." {
			t.Errorf("expected SAML response, got %s", params["SAMLResponse"])
		}
		if params["RelayState"] != "relay-state-123" {
			t.Errorf("expected relay state relay-state-123, got %s", params["RelayState"])
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"email":        "bob@acme.com",
			"name":         "Bob Jones",
			"sub":          "saml-nameid-456",
			"developerId":  "dev-2",
			"groups":       []string{"engineering"},
			"mappedScopes": []string{"read"},
			"principalId":  nil,
			"sessionId":    "sess-2",
			"expiresAt":    "2026-03-30T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.HandleSamlCallback(context.Background(), SsoSamlCallbackParams{
		SAMLResponse: "PHNhbWw+...",
		RelayState:   "relay-state-123",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Email == nil || *result.Email != "bob@acme.com" {
		t.Errorf("expected bob@acme.com, got %v", result.Email)
	}
	if result.PrincipalID != nil {
		t.Errorf("expected null principalId, got %v", result.PrincipalID)
	}
	if result.SessionID != "sess-2" {
		t.Errorf("expected sessionId sess-2, got %s", result.SessionID)
	}
}

// --- LDAP Tests ---

func TestSSOHandleLdapCallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sso/callback/ldap" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params SsoLdapCallbackParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.Username != "carol" {
			t.Errorf("expected username carol, got %s", params.Username)
		}
		if params.Password != "secret" {
			t.Errorf("expected password secret, got %s", params.Password)
		}
		if params.ConnectionID != "sso-conn-3" {
			t.Errorf("expected connectionId sso-conn-3, got %s", params.ConnectionID)
		}
		if params.Org != "acme-corp" {
			t.Errorf("expected org acme-corp, got %s", params.Org)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"email":        nil,
			"name":         nil,
			"sub":          "uid=carol,ou=people,dc=corp,dc=com",
			"developerId":  "dev-1",
			"groups":       []string{},
			"mappedScopes": []string{"read"},
			"principalId":  "prn-3",
			"sessionId":    "sess-3",
			"expiresAt":    "2026-03-30T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.HandleLdapCallback(context.Background(), SsoLdapCallbackParams{
		Username:     "carol",
		Password:     "secret",
		ConnectionID: "sso-conn-3",
		Org:          "acme-corp",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Email != nil {
		t.Errorf("expected null email, got %v", result.Email)
	}
	if len(result.Groups) != 0 {
		t.Errorf("expected no discovered groups, got %v", result.Groups)
	}
	if result.SessionID != "sess-3" {
		t.Errorf("expected sessionId sess-3, got %s", result.SessionID)
	}
}

func TestSSOCreateLdapConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/connections" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params CreateSsoConnectionParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.Name != "Corp LDAP" {
			t.Errorf("expected name 'Corp LDAP', got %s", params.Name)
		}
		if params.Protocol != "ldap" {
			t.Errorf("expected protocol 'ldap', got %s", params.Protocol)
		}
		if params.LdapURL != "ldap://ldap.corp.com:389" {
			t.Errorf("expected ldapUrl, got %s", params.LdapURL)
		}
		if params.LdapBindDN != "cn=admin,dc=corp,dc=com" {
			t.Errorf("expected ldapBindDn, got %s", params.LdapBindDN)
		}
		if params.LdapBindPassword != "admin_secret" {
			t.Errorf("expected ldapBindPassword, got %s", params.LdapBindPassword)
		}
		if params.LdapSearchBase != "ou=users,dc=corp,dc=com" {
			t.Errorf("expected ldapSearchBase, got %s", params.LdapSearchBase)
		}
		if !params.LdapTlsEnabled {
			t.Error("expected ldapTlsEnabled to be true")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoConnection{
			ID:               "sso-conn-3",
			DeveloperID:      "dev-1",
			Name:             "Corp LDAP",
			Protocol:         "ldap",
			Status:           "active",
			LdapURL:          "ldap://ldap.corp.com:389",
			LdapBindDN:       "cn=admin,dc=corp,dc=com",
			LdapSearchBase:   "ou=users,dc=corp,dc=com",
			LdapSearchFilter: "(uid={{username}})",
			LdapTlsEnabled:   true,
			Domains:          []string{"corp.com"},
			CreatedAt:        "2026-03-29T00:00:00Z",
			UpdatedAt:        "2026-03-29T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	conn, err := client.SSO.CreateConnection(context.Background(), CreateSsoConnectionParams{
		Name:             "Corp LDAP",
		Protocol:         "ldap",
		LdapURL:          "ldap://ldap.corp.com:389",
		LdapBindDN:       "cn=admin,dc=corp,dc=com",
		LdapBindPassword: "admin_secret",
		LdapSearchBase:   "ou=users,dc=corp,dc=com",
		LdapSearchFilter: "(uid={{username}})",
		LdapTlsEnabled:   true,
		Domains:          []string{"corp.com"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if conn.ID != "sso-conn-3" {
		t.Errorf("expected id sso-conn-3, got %s", conn.ID)
	}
	if conn.Protocol != "ldap" {
		t.Errorf("expected protocol ldap, got %s", conn.Protocol)
	}
	if conn.LdapURL != "ldap://ldap.corp.com:389" {
		t.Errorf("expected ldapUrl, got %s", conn.LdapURL)
	}
	if conn.LdapBindDN != "cn=admin,dc=corp,dc=com" {
		t.Errorf("expected ldapBindDn, got %s", conn.LdapBindDN)
	}
	if conn.LdapSearchBase != "ou=users,dc=corp,dc=com" {
		t.Errorf("expected ldapSearchBase, got %s", conn.LdapSearchBase)
	}
	if !conn.LdapTlsEnabled {
		t.Error("expected ldapTlsEnabled to be true")
	}
	if conn.Status != "active" {
		t.Errorf("expected status active, got %s", conn.Status)
	}
}

// --- Legacy Tests (backward compatibility) ---

func TestSSOCreateConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/config" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoConfig{
			IssuerURL:   "https://accounts.google.com",
			ClientID:    "client-123",
			RedirectURI: "https://example.com/callback",
			CreatedAt:   "2026-03-01T00:00:00Z",
			UpdatedAt:   "2026-03-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	config, err := client.SSO.CreateConfig(context.Background(), CreateSsoConfigParams{
		IssuerURL:    "https://accounts.google.com",
		ClientID:     "client-123",
		ClientSecret: "secret-abc",
		RedirectURI:  "https://example.com/callback",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if config.IssuerURL != "https://accounts.google.com" {
		t.Errorf("expected google issuer, got %s", config.IssuerURL)
	}
}

func TestSSOGetConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/config" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoConfig{
			IssuerURL: "https://accounts.google.com",
			ClientID:  "client-123",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	config, err := client.SSO.GetConfig(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if config.ClientID != "client-123" {
		t.Errorf("expected client-123, got %s", config.ClientID)
	}
}

func TestSSODeleteConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/config" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.SSO.DeleteConfig(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSSOGetLoginURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sso/login" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("org") != "acme-corp" {
			t.Errorf("expected org=acme-corp, got %s", r.URL.Query().Get("org"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoLoginResponse{
			AuthorizeURL: "https://accounts.google.com/authorize?client_id=123",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.GetLoginURL(context.Background(), "acme-corp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.AuthorizeURL == "" {
		t.Error("expected authorize URL")
	}
}

func TestSSOHandleCallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sso/callback" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("code") != "auth-code" || r.URL.Query().Get("state") != "state-123" {
			t.Errorf("unexpected callback query: %s", r.URL.RawQuery)
		}
		email := "alice@example.com"
		name := "Alice"
		sub := "sub-123"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoCallbackResponse{
			Email:       &email,
			Name:        &name,
			Sub:         &sub,
			DeveloperID: "dev-1",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.HandleCallback(context.Background(), "auth-code", "state-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if *result.Email != "alice@example.com" {
		t.Errorf("expected alice@example.com, got %s", *result.Email)
	}
	if result.DeveloperID != "dev-1" {
		t.Errorf("expected dev-1, got %s", result.DeveloperID)
	}
}
