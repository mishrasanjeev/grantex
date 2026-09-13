package client

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return NewClient("test-key", srv.URL)
}

func strPtr(s string) *string { return &s }

func TestAPIErrorDecodesRouteErrorShape(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		body     string
		wantMsg  string
		wantCode string
	}{
		{
			name:     "routes emit message/code/requestId",
			status:   http.StatusNotFound,
			body:     `{"message":"Agent not found","code":"NOT_FOUND","requestId":"req_1"}`,
			wantMsg:  "Agent not found",
			wantCode: "NOT_FOUND",
		},
		{
			name:     "non-JSON body falls back to raw text",
			status:   http.StatusBadGateway,
			body:     `bad gateway`,
			wantMsg:  "bad gateway",
			wantCode: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			})

			_, err := c.GetAgent("agt_1")
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("expected *APIError, got %T (%v)", err, err)
			}
			if apiErr.StatusCode != tc.status {
				t.Errorf("StatusCode = %d, want %d", apiErr.StatusCode, tc.status)
			}
			if apiErr.Message != tc.wantMsg {
				t.Errorf("Message = %q, want %q", apiErr.Message, tc.wantMsg)
			}
			if apiErr.Code != tc.wantCode {
				t.Errorf("Code = %q, want %q", apiErr.Code, tc.wantCode)
			}
		})
	}
}

func TestIsNotFound(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"404 APIError", &APIError{StatusCode: 404}, true},
		{"500 APIError", &APIError{StatusCode: 500}, false},
		{"plain error", errors.New("boom"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsNotFound(tc.err); got != tc.want {
				t.Errorf("IsNotFound(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestBudgetAllocationDecodesNumericStringsAndNumbers(t *testing.T) {
	cases := []struct {
		name          string
		body          string
		wantInitial   float64
		wantRemaining float64
	}{
		{
			name:          "NUMERIC(18,4) serialised as strings",
			body:          `{"id":"bud_1","grantId":"grt_1","initialBudget":"50.0000","remainingBudget":"12.5000","currency":"USD","createdAt":"2026-01-01T00:00:00.000Z"}`,
			wantInitial:   50,
			wantRemaining: 12.5,
		},
		{
			name:          "plain JSON numbers",
			body:          `{"id":"bud_1","grantId":"grt_1","initialBudget":50,"remainingBudget":12.5,"currency":"USD","createdAt":"2026-01-01T00:00:00.000Z"}`,
			wantInitial:   50,
			wantRemaining: 12.5,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var alloc BudgetAllocation
			if err := json.Unmarshal([]byte(tc.body), &alloc); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			initial, err := alloc.InitialBudgetFloat()
			if err != nil {
				t.Fatalf("InitialBudgetFloat: %v", err)
			}
			remaining, err := alloc.RemainingBudgetFloat()
			if err != nil {
				t.Fatalf("RemainingBudgetFloat: %v", err)
			}
			if initial != tc.wantInitial {
				t.Errorf("initial = %v, want %v", initial, tc.wantInitial)
			}
			if remaining != tc.wantRemaining {
				t.Errorf("remaining = %v, want %v", remaining, tc.wantRemaining)
			}
		})
	}
}

func TestCreateBudgetAllocationRoundTrip(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/budget/allocate" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var req CreateBudgetAllocationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if req.InitialBudget != 50 {
			t.Errorf("initialBudget sent as %v, want 50", req.InitialBudget)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"id":"bud_1","grantId":"grt_1","initialBudget":"50.0000","remainingBudget":"50.0000","currency":"USD","createdAt":"2026-01-01T00:00:00.000Z"}`)
	})

	alloc, err := c.CreateBudgetAllocation(CreateBudgetAllocationRequest{GrantID: "grt_1", InitialBudget: 50, Currency: "USD"})
	if err != nil {
		t.Fatalf("CreateBudgetAllocation returned error for a successful create: %v", err)
	}
	if got, _ := alloc.RemainingBudgetFloat(); got != 50 {
		t.Errorf("remaining = %v, want 50", got)
	}
}

func TestListGrantsEscapesFilters(t *testing.T) {
	cases := []struct {
		name         string
		agentID      string
		principalID  string
		status       string
		wantRawQuery string
	}{
		{name: "no filters", wantRawQuery: ""},
		{
			name:         "reserved characters are escaped",
			agentID:      "agt 1",
			principalID:  "user@example.com&status=revoked",
			status:       "active",
			wantRawQuery: "agentId=agt+1&principalId=user%40example.com%26status%3Drevoked&status=active",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/grants" {
					t.Errorf("path = %q, want /v1/grants", r.URL.Path)
				}
				if r.URL.RawQuery != tc.wantRawQuery {
					t.Errorf("RawQuery = %q, want %q", r.URL.RawQuery, tc.wantRawQuery)
				}
				q := r.URL.Query()
				if q.Get("agentId") != tc.agentID || q.Get("principalId") != tc.principalID || q.Get("status") != tc.status {
					t.Errorf("decoded query = %v", q)
				}
				_, _ = io.WriteString(w, `{"grants":[{"grantId":"grt_1","agentId":"agt_1","principalId":"p","scopes":["read"],"status":"active","issuedAt":"2026-01-01T00:00:00.000Z","expiresAt":"2026-01-02T00:00:00.000Z"}]}`)
			})

			grants, err := c.ListGrants(tc.agentID, tc.principalID, tc.status)
			if err != nil {
				t.Fatalf("ListGrants: %v", err)
			}
			if len(grants) != 1 || grants[0].IssuedAt != "2026-01-01T00:00:00.000Z" {
				t.Errorf("grants = %+v, want one grant with issuedAt populated", grants)
			}
		})
	}
}

func TestGetWebhookFindsByIDViaList(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/webhooks" {
			t.Errorf("unexpected request %s %s (the API has no GET /v1/webhooks/:id)", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = io.WriteString(w, `{"webhooks":[{"id":"wh_1","url":"https://a","events":["grant.created"],"createdAt":"x"},{"id":"wh_2","url":"https://b","events":["grant.revoked"],"createdAt":"y"}]}`)
	})

	cases := []struct {
		name     string
		id       string
		wantURL  string
		wantMiss bool
	}{
		{name: "existing webhook", id: "wh_2", wantURL: "https://b"},
		{name: "missing webhook is a 404 APIError", id: "wh_x", wantMiss: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wh, err := c.GetWebhook(tc.id)
			if tc.wantMiss {
				if !IsNotFound(err) {
					t.Fatalf("expected not-found error, got %v (wh=%+v)", err, wh)
				}
				return
			}
			if err != nil {
				t.Fatalf("GetWebhook: %v", err)
			}
			if wh.URL != tc.wantURL {
				t.Errorf("URL = %q, want %q", wh.URL, tc.wantURL)
			}
		})
	}
}

func TestUpdatePolicyRequestSendsExplicitNullsAndZero(t *testing.T) {
	cases := []struct {
		name string
		req  UpdatePolicyRequest
		want map[string]interface{}
	}{
		{
			name: "cleared optional fields are sent as null, priority 0 is sent",
			req:  UpdatePolicyRequest{Name: "n", Effect: "allow", Priority: 0},
			want: map[string]interface{}{
				"name": "n", "effect": "allow", "priority": float64(0),
				"agentId": nil, "principalId": nil, "scopes": nil,
				"timeOfDayStart": nil, "timeOfDayEnd": nil,
			},
		},
		{
			name: "set fields are sent verbatim",
			req: UpdatePolicyRequest{
				Name: "n", Effect: "deny", Priority: 10,
				AgentID: strPtr("agt_1"), PrincipalID: strPtr("p"), Scopes: []string{"read"},
				TimeOfDayStart: strPtr("00:00"), TimeOfDayEnd: strPtr("08:00"),
			},
			want: map[string]interface{}{
				"name": "n", "effect": "deny", "priority": float64(10),
				"agentId": "agt_1", "principalId": "p", "scopes": []interface{}{"read"},
				"timeOfDayStart": "00:00", "timeOfDayEnd": "08:00",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.req)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var got map[string]interface{}
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			for key, want := range tc.want {
				gotVal, present := got[key]
				if !present {
					t.Errorf("key %q missing from %s", key, raw)
					continue
				}
				if wantList, ok := want.([]interface{}); ok {
					gotList, _ := gotVal.([]interface{})
					if len(gotList) != len(wantList) || (len(wantList) > 0 && gotList[0] != wantList[0]) {
						t.Errorf("%s = %v, want %v", key, gotVal, want)
					}
					continue
				}
				if gotVal != want {
					t.Errorf("%s = %v, want %v", key, gotVal, want)
				}
			}
		})
	}
}

func TestUpdateAgentRequestDescription(t *testing.T) {
	cases := []struct {
		name        string
		description *string
		wantPresent bool
		wantValue   string
	}{
		{name: "nil keeps the current value (key omitted)", description: nil, wantPresent: false},
		{name: "empty string clears the value", description: strPtr(""), wantPresent: true, wantValue: ""},
		{name: "value is sent", description: strPtr("desc"), wantPresent: true, wantValue: "desc"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(UpdateAgentRequest{Name: "n", Scopes: []string{"read"}, Description: tc.description})
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var got map[string]interface{}
			_ = json.Unmarshal(raw, &got)
			val, present := got["description"]
			if present != tc.wantPresent {
				t.Fatalf("description present = %v, want %v (%s)", present, tc.wantPresent, raw)
			}
			if present && val != tc.wantValue {
				t.Errorf("description = %v, want %q", val, tc.wantValue)
			}
		})
	}
}

func TestUpsertSSOConfigUsesPostWithApiFields(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/sso/config" {
			t.Errorf("unexpected request %s %s, want POST /v1/sso/config", r.Method, r.URL.Path)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		}
		for _, key := range []string{"issuerUrl", "clientId", "clientSecret", "redirectUri"} {
			if _, ok := body[key]; !ok {
				t.Errorf("request body missing %q: %v", key, body)
			}
		}
		for _, key := range []string{"provider", "domain", "metadataUrl"} {
			if _, ok := body[key]; ok {
				t.Errorf("request body must not contain legacy field %q", key)
			}
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"issuerUrl":"https://idp.example.com","clientId":"cid","redirectUri":"https://app.example.com/cb","createdAt":"c","updatedAt":"u"}`)
	})

	cfg, err := c.UpsertSSOConfig(UpsertSSOConfigRequest{
		IssuerURL: "https://idp.example.com", ClientID: "cid", ClientSecret: "s", RedirectURI: "https://app.example.com/cb",
	})
	if err != nil {
		t.Fatalf("UpsertSSOConfig: %v", err)
	}
	if cfg.IssuerURL != "https://idp.example.com" || cfg.ClientID != "cid" || cfg.RedirectURI != "https://app.example.com/cb" || cfg.UpdatedAt != "u" {
		t.Errorf("unexpected config %+v", cfg)
	}
}
