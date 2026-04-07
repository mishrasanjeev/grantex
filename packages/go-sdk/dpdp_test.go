package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDPDPCreateConsentRecord(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/dpdp/consent-records" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params CreateConsentRecordParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.GrantID != "grant-1" {
			t.Errorf("expected grant-1, got %s", params.GrantID)
		}
		if params.DataPrincipalID != "user-abc" {
			t.Errorf("expected user-abc, got %s", params.DataPrincipalID)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(ConsentRecord{
			RecordID:        "cr-1",
			GrantID:         "grant-1",
			DataPrincipalID: "user-abc",
			Status:          "active",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	record, err := client.DPDP.CreateConsentRecord(context.Background(), CreateConsentRecordParams{
		GrantID:             "grant-1",
		DataPrincipalID:     "user-abc",
		Purposes:            []ConsentPurpose{{Code: "marketing", Description: "Email marketing"}},
		ConsentNoticeID:     "notice-v1",
		ProcessingExpiresAt: "2027-04-01T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if record.RecordID != "cr-1" {
		t.Errorf("expected cr-1, got %s", record.RecordID)
	}
	if record.Status != "active" {
		t.Errorf("expected active, got %s", record.Status)
	}
}

func TestDPDPGetConsentRecord(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/dpdp/consent-records/cr-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ConsentRecord{
			RecordID:        "cr-1",
			GrantID:         "grant-1",
			DataPrincipalID: "user-abc",
			Status:          "active",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	record, err := client.DPDP.GetConsentRecord(context.Background(), "cr-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if record.RecordID != "cr-1" {
		t.Errorf("expected cr-1, got %s", record.RecordID)
	}
	if record.DataPrincipalID != "user-abc" {
		t.Errorf("expected user-abc, got %s", record.DataPrincipalID)
	}
}

func TestDPDPListConsentRecords(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/dpdp/consent-records" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(listConsentRecordsResponse{
			Records: []ConsentRecord{
				{RecordID: "cr-1", Status: "active"},
				{RecordID: "cr-2", Status: "withdrawn"},
			},
			TotalRecords: 2,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	records, err := client.DPDP.ListConsentRecords(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(records) != 2 {
		t.Errorf("expected 2 records, got %d", len(records))
	}
}

func TestDPDPListConsentRecordsWithFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("dataPrincipalId") != "user-abc" {
			t.Errorf("expected dataPrincipalId=user-abc, got %s", r.URL.Query().Get("dataPrincipalId"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(listConsentRecordsResponse{
			Records:      []ConsentRecord{{RecordID: "cr-1", DataPrincipalID: "user-abc", Status: "active"}},
			TotalRecords: 1,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	records, err := client.DPDP.ListConsentRecords(context.Background(), "user-abc")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(records) != 1 {
		t.Errorf("expected 1 record, got %d", len(records))
	}
}

func TestDPDPWithdrawConsent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/dpdp/consent-records/cr-1/withdraw" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params WithdrawConsentParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.Reason != "User requested" {
			t.Errorf("expected 'User requested', got %s", params.Reason)
		}
		if !params.RevokeGrant {
			t.Error("expected RevokeGrant to be true")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(WithdrawConsentResponse{
			RecordID:     "cr-1",
			Status:       "withdrawn",
			WithdrawnAt:  "2026-04-02T00:00:00Z",
			GrantRevoked: true,
			DataDeleted:  true,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	resp, err := client.DPDP.WithdrawConsent(context.Background(), "cr-1", WithdrawConsentParams{
		Reason:              "User requested",
		RevokeGrant:         true,
		DeleteProcessedData: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != "withdrawn" {
		t.Errorf("expected withdrawn, got %s", resp.Status)
	}
	if !resp.GrantRevoked {
		t.Error("expected GrantRevoked to be true")
	}
}

func TestDPDPListPrincipalRecords(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/dpdp/data-principals/user-abc/records" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(PrincipalRecordsResponse{
			DataPrincipalID: "user-abc",
			Records:         []ConsentRecord{{RecordID: "cr-1", Status: "active"}},
			TotalRecords:    1,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	resp, err := client.DPDP.ListPrincipalRecords(context.Background(), "user-abc")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.DataPrincipalID != "user-abc" {
		t.Errorf("expected user-abc, got %s", resp.DataPrincipalID)
	}
	if resp.TotalRecords != 1 {
		t.Errorf("expected 1 total record, got %d", resp.TotalRecords)
	}
}

func TestDPDPRequestErasure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/dpdp/data-principals/user-abc/erasure" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(ErasureResponse{
			RequestID:            "ER-2026-00001",
			DataPrincipalID:      "user-abc",
			Status:               "completed",
			RecordsErased:        2,
			GrantsRevoked:        1,
			SubmittedAt:          "2026-04-02T00:00:00Z",
			ExpectedCompletionBy: "2026-04-09T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	resp, err := client.DPDP.RequestErasure(context.Background(), "user-abc")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.RequestID != "ER-2026-00001" {
		t.Errorf("expected ER-2026-00001, got %s", resp.RequestID)
	}
	if resp.RecordsErased != 2 {
		t.Errorf("expected 2, got %d", resp.RecordsErased)
	}
}

func TestDPDPCreateConsentNotice(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/dpdp/consent-notices" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params CreateConsentNoticeParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.NoticeID != "notice-v1" {
			t.Errorf("expected notice-v1, got %s", params.NoticeID)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(ConsentNotice{
			ID:          "cn-1",
			NoticeID:    "notice-v1",
			Version:     "1.0",
			Language:    "en",
			ContentHash: "sha256abc",
			CreatedAt:   "2026-04-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	notice, err := client.DPDP.CreateConsentNotice(context.Background(), CreateConsentNoticeParams{
		NoticeID: "notice-v1",
		Version:  "1.0",
		Title:    "Privacy Notice",
		Content:  "We process your data for...",
		Purposes: []ConsentPurpose{{Code: "marketing", Description: "Email marketing"}},
		Language: "en",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if notice.ID != "cn-1" {
		t.Errorf("expected cn-1, got %s", notice.ID)
	}
	if notice.ContentHash != "sha256abc" {
		t.Errorf("expected sha256abc, got %s", notice.ContentHash)
	}
}

func TestDPDPFileGrievance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/dpdp/grievances" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params FileGrievanceParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.DataPrincipalID != "user-abc" {
			t.Errorf("expected user-abc, got %s", params.DataPrincipalID)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(202)
		json.NewEncoder(w).Encode(Grievance{
			GrievanceID:          "grv-1",
			ReferenceNumber:      "GRV-2026-00001",
			Type:                 "consent-violation",
			Status:               "submitted",
			DataPrincipalID:      "user-abc",
			ExpectedResolutionBy: "2026-04-08T00:00:00Z",
			CreatedAt:            "2026-04-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	grv, err := client.DPDP.FileGrievance(context.Background(), FileGrievanceParams{
		DataPrincipalID: "user-abc",
		Type:            "consent-violation",
		Description:     "Consent was not obtained",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if grv.GrievanceID != "grv-1" {
		t.Errorf("expected grv-1, got %s", grv.GrievanceID)
	}
	if grv.ReferenceNumber != "GRV-2026-00001" {
		t.Errorf("expected GRV-2026-00001, got %s", grv.ReferenceNumber)
	}
}

func TestDPDPGetGrievance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/dpdp/grievances/grv-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Grievance{
			GrievanceID:     "grv-1",
			Type:            "consent-violation",
			Status:          "submitted",
			DataPrincipalID: "user-abc",
			Description:     "Consent was not obtained",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	grv, err := client.DPDP.GetGrievance(context.Background(), "grv-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if grv.GrievanceID != "grv-1" {
		t.Errorf("expected grv-1, got %s", grv.GrievanceID)
	}
	if grv.Type != "consent-violation" {
		t.Errorf("expected consent-violation, got %s", grv.Type)
	}
}

func TestDPDPCreateExport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/dpdp/exports" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params CreateExportParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.Type != "dpdp-audit" {
			t.Errorf("expected dpdp-audit, got %s", params.Type)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(ComplianceExport{
			ExportID:    "exp-1",
			Type:        "dpdp-audit",
			Format:      "json",
			RecordCount: 5,
			ExpiresAt:   "2026-04-08T00:00:00Z",
			CreatedAt:   "2026-04-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	exp, err := client.DPDP.CreateExport(context.Background(), CreateExportParams{
		Type:     "dpdp-audit",
		DateFrom: "2026-01-01",
		DateTo:   "2026-04-01",
		Format:   "json",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if exp.ExportID != "exp-1" {
		t.Errorf("expected exp-1, got %s", exp.ExportID)
	}
	if exp.RecordCount != 5 {
		t.Errorf("expected 5, got %d", exp.RecordCount)
	}
}

func TestDPDPGetExport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/dpdp/exports/exp-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ComplianceExport{
			ExportID:    "exp-1",
			Type:        "dpdp-audit",
			Status:      "completed",
			Format:      "json",
			RecordCount: 5,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	exp, err := client.DPDP.GetExport(context.Background(), "exp-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if exp.ExportID != "exp-1" {
		t.Errorf("expected exp-1, got %s", exp.ExportID)
	}
	if exp.Status != "completed" {
		t.Errorf("expected completed, got %s", exp.Status)
	}
}
