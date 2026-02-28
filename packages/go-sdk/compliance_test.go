package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestComplianceGetSummary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/compliance/summary" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ComplianceSummary{
			GeneratedAt: "2026-03-01T00:00:00Z",
			Agents:      ComplianceSummaryAgents{Total: 5, Active: 3},
			Grants:      ComplianceSummaryGrants{Total: 10, Active: 8},
			Plan:        "pro",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	summary, err := client.Compliance.GetSummary(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary.Agents.Total != 5 {
		t.Errorf("expected 5 agents, got %d", summary.Agents.Total)
	}
	if summary.Plan != "pro" {
		t.Errorf("expected pro, got %s", summary.Plan)
	}
}

func TestComplianceGetSummaryWithParams(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("since") != "2026-01-01" {
			t.Errorf("expected since=2026-01-01")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ComplianceSummary{GeneratedAt: "2026-03-01T00:00:00Z"})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	_, err := client.Compliance.GetSummary(context.Background(), &ComplianceSummaryParams{
		Since: "2026-01-01",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestComplianceExportGrants(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/compliance/export/grants" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ComplianceGrantsExport{
			GeneratedAt: "2026-03-01T00:00:00Z",
			Total:       2,
			Grants:      []Grant{{ID: "g-1"}, {ID: "g-2"}},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Compliance.ExportGrants(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 2 {
		t.Errorf("expected 2, got %d", result.Total)
	}
}

func TestComplianceExportAudit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/compliance/export/audit" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ComplianceAuditExport{
			GeneratedAt: "2026-03-01T00:00:00Z",
			Total:       1,
			Entries:     []AuditEntry{{EntryID: "e-1"}},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Compliance.ExportAudit(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 1 {
		t.Errorf("expected 1, got %d", result.Total)
	}
}

func TestComplianceEvidencePack(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/compliance/evidence-pack" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(EvidencePack{
			Meta: EvidencePackMeta{
				SchemaVersion: "1.0",
				GeneratedAt:   "2026-03-01T00:00:00Z",
				Framework:     "soc2",
			},
			ChainIntegrity: ChainIntegrity{Valid: true, CheckedEntries: 10},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Compliance.EvidencePack(context.Background(), &EvidencePackParams{
		Framework: "soc2",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Meta.Framework != "soc2" {
		t.Errorf("expected soc2, got %s", result.Meta.Framework)
	}
	if !result.ChainIntegrity.Valid {
		t.Error("expected chain integrity valid")
	}
}
