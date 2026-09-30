package grantex

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// dpdpFixtures holds the response bodies the auth-service DPDP routes send
// (testdata/dpdp-server-fixtures.json). Keys starting with "_" are
// annotations and "<name>" strings refer to another fixture; dpdpFixture
// resolves both.
var dpdpFixtures map[string]interface{}

func loadDPDPFixtures(t *testing.T) map[string]interface{} {
	t.Helper()
	if dpdpFixtures == nil {
		raw, err := os.ReadFile(filepath.Join("testdata", "dpdp-server-fixtures.json"))
		if err != nil {
			t.Fatalf("read fixtures: %v", err)
		}
		if err := json.Unmarshal(raw, &dpdpFixtures); err != nil {
			t.Fatalf("parse fixtures: %v", err)
		}
	}
	return dpdpFixtures
}

func resolveFixture(all map[string]interface{}, v interface{}) interface{} {
	switch x := v.(type) {
	case string:
		if strings.HasPrefix(x, "<") && strings.HasSuffix(x, ">") {
			return resolveFixture(all, all[x[1:len(x)-1]])
		}
		return x
	case []interface{}:
		out := make([]interface{}, len(x))
		for i, e := range x {
			out[i] = resolveFixture(all, e)
		}
		return out
	case map[string]interface{}:
		out := map[string]interface{}{}
		for k, e := range x {
			if !strings.HasPrefix(k, "_") {
				out[k] = resolveFixture(all, e)
			}
		}
		return out
	}
	return v
}

func dpdpFixture(t *testing.T, name string) map[string]interface{} {
	t.Helper()
	all := loadDPDPFixtures(t)
	v, ok := all[name]
	if !ok {
		t.Fatalf("no fixture %q", name)
	}
	return resolveFixture(all, v).(map[string]interface{})
}

func dpdpErrorFixture(t *testing.T, name string) map[string]interface{} {
	t.Helper()
	return loadDPDPFixtures(t)["errors"].(map[string]interface{})[name].(map[string]interface{})
}

type recordedRequest struct {
	Method     string
	RequestURI string
	Path       string
	Query      map[string][]string
	Body       []byte
	Header     http.Header
}

// dpdpServer answers every request with status and body and records it.
func dpdpServer(t *testing.T, status int, body interface{}) (*httptest.Server, *[]recordedRequest) {
	t.Helper()
	var reqs []recordedRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		reqs = append(reqs, recordedRequest{
			Method: r.Method, RequestURI: r.RequestURI, Path: r.URL.Path,
			Query: r.URL.Query(), Body: b, Header: r.Header.Clone(),
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(server.Close)
	return server, &reqs
}

func decodeBody(t *testing.T, b []byte) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("request body is not JSON: %q", b)
	}
	return m
}

// ── Consent records ──────────────────────────────────────────────────────────

func TestDPDPCreateConsentRecord(t *testing.T) {
	server, reqs := dpdpServer(t, 201, dpdpFixture(t, "createConsentRecord_201"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	record, err := client.DPDP.CreateConsentRecord(context.Background(), CreateConsentRecordParams{
		GrantID:              "grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V",
		DataPrincipalID:      "user_123",
		Purposes:             []ConsentPurpose{{Code: "analytics", Description: "Usage analytics for service improvement"}},
		ConsentNoticeID:      "privacy-notice",
		ConsentNoticeVersion: "2.0",
		ProcessingExpiresAt:  "2027-09-30T00:00:00.000Z",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if record.RecordID != "crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W" || record.Status != ConsentStatusActive {
		t.Errorf("unexpected record %+v", record)
	}
	if record.ConsentNoticeVersion == nil || *record.ConsentNoticeVersion != "2.0" {
		t.Errorf("expected consentNoticeVersion 2.0, got %v", record.ConsentNoticeVersion)
	}
	if record.ConsentNoticeHash == "" {
		t.Error("expected consentNoticeHash")
	}
	want := &ConsentProof{
		Type:           "JWS-EdDSA",
		Alg:            "EdDSA",
		Kid:            strPtr("ed25519-2026-09"),
		KeyPersistence: "persistent",
		ProofJWT:       record.Proof.ProofJWT,
		JWKSURI:        "https://issuer.example/.well-known/jwks.json",
		SignedAt:       "2026-09-30T10:15:00.000Z",
	}
	if record.Proof == nil || !reflect.DeepEqual(record.Proof, want) || record.Proof.ProofJWT == "" {
		t.Errorf("unexpected proof %+v", record.Proof)
	}
	if record.ConsentProof["type"] != "JWS-EdDSA" {
		t.Errorf("the untyped ConsentProof map must still be populated, got %v", record.ConsentProof)
	}

	body := decodeBody(t, (*reqs)[0].Body)
	if body["consentNoticeVersion"] != "2.0" || body["grantId"] != "grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V" {
		t.Errorf("unexpected request body %v", body)
	}
}

func strPtr(s string) *string { return &s }

func TestDPDPGetConsentRecordHasNoProof(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "consentRecord_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	record, err := client.DPDP.GetConsentRecord(context.Background(), "crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if (*reqs)[0].Path != "/v1/dpdp/consent-records/crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W" || (*reqs)[0].Method != http.MethodGet {
		t.Errorf("unexpected %s %s", (*reqs)[0].Method, (*reqs)[0].Path)
	}
	if record.DataPrincipalID != "user_123" || record.Proof != nil || record.ConsentNoticeHash != "" {
		t.Errorf("unexpected record %+v", record)
	}
	if len(record.Purposes) != 2 || record.Purposes[0] != (ConsentPurpose{Code: "analytics", Description: "Usage analytics for service improvement"}) {
		t.Errorf("unexpected purposes %+v", record.Purposes)
	}
}

func TestDPDPGetErasedLegacyRecord(t *testing.T) {
	server, _ := dpdpServer(t, 200, dpdpFixture(t, "consentRecord_erased_legacy_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	record, err := client.DPDP.GetConsentRecord(context.Background(), "crec_01J9Z0AAAAAAAAAAAAAAAAAAAA")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if record.Status != ConsentStatusErased {
		t.Errorf("expected erased, got %s", record.Status)
	}
	if record.ErasedAt == nil || *record.ErasedAt != "2026-09-29T12:00:00.000Z" {
		t.Errorf("unexpected erasedAt %v", record.ErasedAt)
	}
	if record.ConsentNoticeVersion != nil {
		t.Errorf("expected nil consentNoticeVersion, got %v", *record.ConsentNoticeVersion)
	}
}

func TestDPDPListConsentRecords(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "listConsentRecords_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	records, err := client.DPDP.ListConsentRecords(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(records) != 2 {
		t.Errorf("expected 2 records, got %d", len(records))
	}
	if (*reqs)[0].RequestURI != "/v1/dpdp/consent-records" {
		t.Errorf("unexpected request %s", (*reqs)[0].RequestURI)
	}
}

func TestDPDPListConsentRecordsWithFilter(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "listConsentRecords_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	if _, err := client.DPDP.ListConsentRecords(context.Background(), "user-abc"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := (*reqs)[0].Query["dataPrincipalId"]; len(got) != 1 || got[0] != "user-abc" {
		t.Errorf("expected dataPrincipalId=user-abc, got %v", got)
	}
}

func TestDPDPListConsentRecordsPage(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "listConsentRecords_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	page, err := client.DPDP.ListConsentRecordsPage(context.Background(), ListConsentRecordsParams{
		DataPrincipalID: "user_123", Limit: 2, Cursor: "eyJ0Ijo+/=",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(page.Records) != 2 || page.TotalRecords != 7 {
		t.Errorf("unexpected page %+v", page)
	}
	if page.NextCursor == nil || !strings.HasPrefix(*page.NextCursor, "eyJ") {
		t.Errorf("unexpected nextCursor %v", page.NextCursor)
	}
	want := map[string][]string{"dataPrincipalId": {"user_123"}, "limit": {"2"}, "cursor": {"eyJ0Ijo+/="}}
	if !reflect.DeepEqual((*reqs)[0].Query, want) {
		t.Errorf("unexpected query %v", (*reqs)[0].Query)
	}
}

func TestDPDPWithdrawConsent(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "withdrawConsent_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	resp, err := client.DPDP.WithdrawConsent(context.Background(), "crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W", WithdrawConsentParams{
		Reason:              "User requested",
		RevokeGrant:         true,
		DeleteProcessedData: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != ConsentStatusWithdrawn || !resp.GrantRevoked || resp.DataDeleted || !resp.DataDeletionRequested {
		t.Errorf("unexpected response %+v", resp)
	}
	r := (*reqs)[0]
	if r.Path != "/v1/dpdp/consent-records/crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W/withdraw" || r.Method != http.MethodPost {
		t.Errorf("unexpected %s %s", r.Method, r.Path)
	}
	want := map[string]interface{}{"reason": "User requested", "revokeGrant": true, "deleteProcessedData": true}
	if got := decodeBody(t, r.Body); !reflect.DeepEqual(got, want) {
		t.Errorf("unexpected body %v", got)
	}
}

func TestDPDPWithdrawConsentMinimalAndKeepGrant(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "withdrawConsent_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))
	ctx := context.Background()

	if _, err := client.DPDP.WithdrawConsent(ctx, "cr_01", WithdrawConsentParams{Reason: "r"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := decodeBody(t, (*reqs)[0].Body); !reflect.DeepEqual(got, map[string]interface{}{"reason": "r"}) {
		t.Errorf("unexpected minimal body %v", got)
	}

	if _, err := client.DPDP.WithdrawConsent(ctx, "cr_01", WithdrawConsentParams{Reason: "r", KeepGrant: true}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := decodeBody(t, (*reqs)[1].Body); !reflect.DeepEqual(got, map[string]interface{}{"reason": "r", "revokeGrant": false}) {
		t.Errorf("KeepGrant must send revokeGrant:false, got %v", got)
	}

	_, err := client.DPDP.WithdrawConsent(ctx, "cr_01", WithdrawConsentParams{Reason: "r", KeepGrant: true, RevokeGrant: true})
	if err == nil || len(*reqs) != 2 {
		t.Errorf("RevokeGrant with KeepGrant must fail before sending, err=%v requests=%d", err, len(*reqs))
	}
}

// ── Data principal rights ────────────────────────────────────────────────────

func TestDPDPListPrincipalRecords(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "principalRecords_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	resp, err := client.DPDP.ListPrincipalRecords(context.Background(), "user_123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if (*reqs)[0].Path != "/v1/dpdp/data-principals/user_123/records" {
		t.Errorf("unexpected path %s", (*reqs)[0].Path)
	}
	if resp.DataPrincipalID != "user_123" || resp.TotalRecords != 1 || resp.NextCursor != nil {
		t.Errorf("unexpected response %+v", resp)
	}
}

func TestDPDPListPrincipalRecordsFillsMissingPrincipal(t *testing.T) {
	body := dpdpFixture(t, "principalRecords_200")
	for _, r := range body["records"].([]interface{}) {
		delete(r.(map[string]interface{}), "dataPrincipalId")
	}
	server, _ := dpdpServer(t, 200, body)
	client := NewClient("test-key", WithBaseURL(server.URL))

	resp, err := client.DPDP.ListPrincipalRecords(context.Background(), "user_123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Records[0].DataPrincipalID != "user_123" {
		t.Errorf("expected the top-level principal, got %q", resp.Records[0].DataPrincipalID)
	}
}

func TestDPDPListPrincipalRecordsPage(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "principalRecords_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	if _, err := client.DPDP.ListPrincipalRecordsPage(context.Background(), "user_123", PageParams{Limit: 10, Cursor: "c1"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := map[string][]string{"limit": {"10"}, "cursor": {"c1"}}
	if !reflect.DeepEqual((*reqs)[0].Query, want) {
		t.Errorf("unexpected query %v", (*reqs)[0].Query)
	}
}

func TestDPDPRequestErasure(t *testing.T) {
	server, reqs := dpdpServer(t, 201, dpdpFixture(t, "erasure_201"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	resp, err := client.DPDP.RequestErasure(context.Background(), "user_123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	r := (*reqs)[0]
	if r.Path != "/v1/dpdp/data-principals/user_123/erasure" || r.Method != http.MethodPost {
		t.Errorf("unexpected %s %s", r.Method, r.Path)
	}
	if len(r.Body) != 0 || r.Header.Get("Content-Type") != "" {
		t.Errorf("erasure must send no body, got %q (Content-Type %q)", r.Body, r.Header.Get("Content-Type"))
	}
	if resp.RequestID != "ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R" || resp.Status != "completed" ||
		resp.RecordsErased != 2 || resp.GrantsRevoked != 1 || resp.DelegatedGrantsRevoked != 0 ||
		resp.GrievancesRedacted != 0 || resp.ExportsDeleted != 0 ||
		resp.CompletedAt != "2026-09-30T14:00:00.120Z" || resp.ExpectedCompletionBy != resp.CompletedAt {
		t.Errorf("unexpected response %+v", resp)
	}
	var categories []string
	for _, r := range resp.Retained {
		categories = append(categories, r.Category)
	}
	wantCategories := []string{"consent_records", "audit_log", "grievances", "stored_exports", "fiduciary_data"}
	if !reflect.DeepEqual(categories, wantCategories) ||
		resp.Retained[0].Count == nil || *resp.Retained[0].Count != 2 || resp.Retained[1].Count != nil ||
		resp.Retained[3].Count == nil || *resp.Retained[3].Count != 1 {
		t.Errorf("unexpected retained %+v", resp.Retained)
	}
}

func TestDPDPGetErasureRequest(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "erasure_201"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	resp, err := client.DPDP.GetErasureRequest(context.Background(), "ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if (*reqs)[0].Path != "/v1/dpdp/erasure-requests/ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R" || (*reqs)[0].Method != http.MethodGet {
		t.Errorf("unexpected %s %s", (*reqs)[0].Method, (*reqs)[0].Path)
	}
	if resp.RecordsErased != 2 {
		t.Errorf("unexpected response %+v", resp)
	}
}

// ── Consent notices ──────────────────────────────────────────────────────────

func TestDPDPCreateConsentNotice(t *testing.T) {
	server, reqs := dpdpServer(t, 201, dpdpFixture(t, "createConsentNotice_201"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	notice, err := client.DPDP.CreateConsentNotice(context.Background(), CreateConsentNoticeParams{
		NoticeID: "privacy-notice",
		Version:  "2.0",
		Title:    "Data Processing Consent Notice",
		Content:  "We collect and process your data for the following purposes...",
		Purposes: []ConsentPurpose{{Code: "analytics", Description: "Usage analytics"}},
		Language: "en",
		GrievanceOfficer: &GrievanceOfficer{
			Name: "Grievance Officer", Email: "grievance@acme.example", Phone: "+91-00000-00000",
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if notice.ID != "notice_01J9ZA1B2C3D4E5F6G7H8J9K0M" || notice.NoticeID != "privacy-notice" || notice.Version != "2.0" {
		t.Errorf("unexpected notice %+v", notice)
	}
	body := decodeBody(t, (*reqs)[0].Body)
	if body["noticeId"] != "privacy-notice" {
		t.Errorf("unexpected body %v", body)
	}
}

func TestDPDPListConsentNotices(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "listConsentNotices_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	resp, err := client.DPDP.ListConsentNotices(context.Background(), PageParams{Limit: 5, Cursor: "c2"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Notices) != 1 || resp.Notices[0].Title != "Data Processing Consent Notice" || resp.NextCursor != nil {
		t.Errorf("unexpected response %+v", resp)
	}
	if (*reqs)[0].Path != "/v1/dpdp/consent-notices" ||
		!reflect.DeepEqual((*reqs)[0].Query, map[string][]string{"limit": {"5"}, "cursor": {"c2"}}) {
		t.Errorf("unexpected request %s", (*reqs)[0].RequestURI)
	}
}

func TestDPDPGetConsentNotice(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "getConsentNotice_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	resp, err := client.DPDP.GetConsentNotice(context.Background(), "privacy-notice")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if (*reqs)[0].Path != "/v1/dpdp/consent-notices/privacy-notice" {
		t.Errorf("unexpected path %s", (*reqs)[0].Path)
	}
	if resp.NoticeID != "privacy-notice" || len(resp.Versions) != 2 ||
		resp.Versions[0].Version != "2.0" || resp.Versions[1].Version != "1.0" {
		t.Fatalf("unexpected response %+v", resp)
	}
	if resp.Versions[0].GrievanceOfficer == nil || resp.Versions[0].GrievanceOfficer.Phone != "+91-00000-00000" {
		t.Errorf("unexpected grievance officer %+v", resp.Versions[0].GrievanceOfficer)
	}
	if resp.Versions[1].GrievanceOfficer != nil || resp.Versions[1].DataFiduciaryContact != nil {
		t.Errorf("expected nulls on the older version, got %+v", resp.Versions[1])
	}
}

// ── Grievances ───────────────────────────────────────────────────────────────

func TestDPDPFileGrievance(t *testing.T) {
	server, reqs := dpdpServer(t, 202, dpdpFixture(t, "fileGrievance_202"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	grv, err := client.DPDP.FileGrievance(context.Background(), FileGrievanceParams{
		DataPrincipalID:    "user_123",
		Type:               "unauthorized-processing",
		Description:        "My data was used for marketing without consent",
		RecordID:           "crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W",
		Evidence:           map[string]interface{}{"screenshots": []interface{}{"https://files.example.com/s1.png"}},
		ResponsePeriodDays: 30,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if grv.GrievanceID != "grv_01J9ZC5D6E7F8G9H0J1K2M3N4P" || grv.ReferenceNumber != "GRV-2026-01J9ZC5D6E7F8G9H0J1K2M3N4Q" ||
		grv.Status != GrievanceStatusSubmitted || grv.ResponsePeriodDays != 7 {
		t.Errorf("unexpected grievance %+v", grv)
	}
	body := decodeBody(t, (*reqs)[0].Body)
	if body["recordId"] != "crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W" || body["responsePeriodDays"] != float64(30) {
		t.Errorf("unexpected body %v", body)
	}
}

func TestDPDPGetGrievance(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "getGrievance_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	grv, err := client.DPDP.GetGrievance(context.Background(), "grv_01J9ZC5D6E7F8G9H0J1K2M3N4P")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if (*reqs)[0].Path != "/v1/dpdp/grievances/grv_01J9ZC5D6E7F8G9H0J1K2M3N4P" {
		t.Errorf("unexpected path %s", (*reqs)[0].Path)
	}
	if grv.Status != GrievanceStatusInReview || grv.Description != "My data was used for marketing without consent" ||
		grv.UpdatedAt == nil || *grv.UpdatedAt != "2026-10-01T08:00:00.000Z" {
		t.Errorf("unexpected grievance %+v", grv)
	}
}

func TestDPDPListGrievances(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "listGrievances_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	resp, err := client.DPDP.ListGrievances(context.Background(), ListGrievancesParams{
		Status: GrievanceStatusSubmitted, DataPrincipalID: "user_123", Limit: 20, Cursor: "c3",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Grievances) != 1 || resp.Grievances[0].Description != "" || resp.NextCursor != nil {
		t.Errorf("unexpected response %+v", resp)
	}
	want := map[string][]string{"status": {"submitted"}, "dataPrincipalId": {"user_123"}, "limit": {"20"}, "cursor": {"c3"}}
	if (*reqs)[0].Path != "/v1/dpdp/grievances" || !reflect.DeepEqual((*reqs)[0].Query, want) {
		t.Errorf("unexpected request %s", (*reqs)[0].RequestURI)
	}
}

func TestDPDPUpdateGrievance(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "updateGrievance_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	grv, err := client.DPDP.UpdateGrievance(context.Background(), "grv_01J9ZC5D6E7F8G9H0J1K2M3N4P", UpdateGrievanceParams{
		Status:     GrievanceStatusResolved,
		Resolution: "Marketing processing stopped and the data principal informed",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	r := (*reqs)[0]
	if r.Method != http.MethodPatch || r.Path != "/v1/dpdp/grievances/grv_01J9ZC5D6E7F8G9H0J1K2M3N4P" {
		t.Errorf("unexpected %s %s", r.Method, r.Path)
	}
	want := map[string]interface{}{"status": "resolved", "resolution": "Marketing processing stopped and the data principal informed"}
	if got := decodeBody(t, r.Body); !reflect.DeepEqual(got, want) {
		t.Errorf("unexpected body %v", got)
	}
	if grv.Status != GrievanceStatusResolved || grv.ResolvedAt == nil || *grv.ResolvedAt != "2026-10-02T09:30:00.000Z" {
		t.Errorf("unexpected grievance %+v", grv)
	}
}

// ── Compliance exports ───────────────────────────────────────────────────────

func TestDPDPCreateExport(t *testing.T) {
	server, reqs := dpdpServer(t, 201, dpdpFixture(t, "createExport_201"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	exp, err := client.DPDP.CreateExport(context.Background(), CreateExportParams{
		Type:     ExportTypeDPDPAudit,
		DateFrom: "2026-09-01T00:00:00.000Z",
		DateTo:   "2026-09-30T23:59:59.999Z",
		Format:   "json",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if exp.ExportID != "exp_01J9ZD6E7F8G9H0J1K2M3N4P5Q" || exp.Type != ExportTypeDPDPAudit || exp.Status != "" ||
		exp.RecordCount != 3 || exp.Truncated || exp.AuditLogLimit != 1000 || exp.DataPrincipalID != nil {
		t.Errorf("unexpected export %+v", exp)
	}
	body := decodeBody(t, (*reqs)[0].Body)
	if body["type"] != "dpdp-audit" || body["dateTo"] != "2026-09-30T23:59:59.999Z" {
		t.Errorf("unexpected body %v", body)
	}
}

func TestDPDPGetExport(t *testing.T) {
	server, reqs := dpdpServer(t, 200, dpdpFixture(t, "getExport_200"))
	client := NewClient("test-key", WithBaseURL(server.URL))

	var exp *DpdpExport
	exp, err := client.DPDP.GetExport(context.Background(), "exp_01J9ZD6E7F8G9H0J1K2M3N4P5Q")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if (*reqs)[0].Path != "/v1/dpdp/exports/exp_01J9ZD6E7F8G9H0J1K2M3N4P5Q" {
		t.Errorf("unexpected path %s", (*reqs)[0].Path)
	}
	if exp.Status != ExportStatusComplete || !exp.Truncated || exp.RecordCount != 1001 ||
		exp.DataPrincipalID == nil || *exp.DataPrincipalID != "user_123" {
		t.Errorf("unexpected export %+v", exp)
	}
}

// ── Path encoding ────────────────────────────────────────────────────────────

func TestDPDPPathParametersAreEscaped(t *testing.T) {
	const id = "user@test.com/../x"
	const enc = "user@test.com%2F..%2Fx" // url.PathEscape: "/" escaped, "@" legal in a segment
	server, reqs := dpdpServer(t, 200, map[string]interface{}{})
	client := NewClient("test-key", WithBaseURL(server.URL))
	d := client.DPDP
	ctx := context.Background()

	_, _ = d.GetConsentRecord(ctx, id)
	_, _ = d.WithdrawConsent(ctx, id, WithdrawConsentParams{Reason: "r"})
	_, _ = d.ListPrincipalRecords(ctx, id)
	_, _ = d.RequestErasure(ctx, id)
	_, _ = d.GetErasureRequest(ctx, id)
	_, _ = d.GetConsentNotice(ctx, id)
	_, _ = d.GetGrievance(ctx, id)
	_, _ = d.UpdateGrievance(ctx, id, UpdateGrievanceParams{Status: GrievanceStatusInReview})
	_, _ = d.GetExport(ctx, id)

	want := []string{
		"/v1/dpdp/consent-records/" + enc,
		"/v1/dpdp/consent-records/" + enc + "/withdraw",
		"/v1/dpdp/data-principals/" + enc + "/records",
		"/v1/dpdp/data-principals/" + enc + "/erasure",
		"/v1/dpdp/erasure-requests/" + enc,
		"/v1/dpdp/consent-notices/" + enc,
		"/v1/dpdp/grievances/" + enc,
		"/v1/dpdp/grievances/" + enc,
		"/v1/dpdp/exports/" + enc,
	}
	var got []string
	for _, r := range *reqs {
		got = append(got, r.RequestURI)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("paths:\n got %v\nwant %v", got, want)
	}
}

// ── No auto-retry on non-idempotent writes ──────────────────────────────────────────────────

type dpdpWrite struct {
	name   string
	invoke func(*Client) error
}

func dpdpWrites() []dpdpWrite {
	ctx := context.Background()
	return []dpdpWrite{
		{"CreateConsentRecord", func(c *Client) error {
			_, err := c.DPDP.CreateConsentRecord(ctx, CreateConsentRecordParams{
				GrantID: "g", DataPrincipalID: "p", Purposes: []ConsentPurpose{{Code: "c", Description: "d"}},
				ConsentNoticeID: "n", ProcessingExpiresAt: "2027-01-01T00:00:00.000Z",
			})
			return err
		}},
		{"WithdrawConsent", func(c *Client) error {
			_, err := c.DPDP.WithdrawConsent(ctx, "r", WithdrawConsentParams{Reason: "x"})
			return err
		}},
		{"CreateConsentNotice", func(c *Client) error {
			_, err := c.DPDP.CreateConsentNotice(ctx, CreateConsentNoticeParams{
				NoticeID: "n", Version: "1", Title: "t", Content: "c", Purposes: []ConsentPurpose{{Code: "c", Description: "d"}},
			})
			return err
		}},
		{"FileGrievance", func(c *Client) error {
			_, err := c.DPDP.FileGrievance(ctx, FileGrievanceParams{DataPrincipalID: "p", Type: "t", Description: "d"})
			return err
		}},
		{"UpdateGrievance", func(c *Client) error {
			_, err := c.DPDP.UpdateGrievance(ctx, "grv", UpdateGrievanceParams{Status: GrievanceStatusInReview})
			return err
		}},
		{"CreateExport", func(c *Client) error {
			_, err := c.DPDP.CreateExport(ctx, CreateExportParams{Type: ExportTypeDPDPAudit, DateFrom: "a", DateTo: "b"})
			return err
		}},
	}
}

func TestDPDPWritesAreNotRetriedAfter503(t *testing.T) {
	for _, w := range dpdpWrites() {
		t.Run(w.name, func(t *testing.T) {
			server, reqs := dpdpServer(t, 503, dpdpErrorFixture(t, "503_CONSENT_PROOF_UNAVAILABLE"))
			client := NewClient("test-key", WithBaseURL(server.URL), WithMaxRetries(3))
			err := w.invoke(client)
			var apiErr *APIError
			if !errors.As(err, &apiErr) || apiErr.StatusCode != 503 {
				t.Fatalf("expected a 503 APIError, got %v", err)
			}
			if len(*reqs) != 1 {
				t.Errorf("expected exactly 1 request, got %d", len(*reqs))
			}
		})
	}
}

func TestDPDPWritesAreNotRetriedAfterTimeout(t *testing.T) {
	for _, w := range dpdpWrites() {
		t.Run(w.name, func(t *testing.T) {
			var count int32
			release := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt32(&count, 1)
				select {
				case <-release:
				case <-r.Context().Done():
				}
			}))
			t.Cleanup(func() { close(release); server.Close() })
			client := NewClient("test-key", WithBaseURL(server.URL), WithMaxRetries(3), WithTimeout(100*time.Millisecond))
			err := w.invoke(client)
			var netErr *NetworkError
			if !errors.As(err, &netErr) {
				t.Fatalf("expected a NetworkError, got %v", err)
			}
			if got := atomic.LoadInt32(&count); got != 1 {
				t.Errorf("expected exactly 1 request, got %d", got)
			}
		})
	}
}

// Erasure is idempotent on the server (a replay returns the earlier request),
// so RequestErasure keeps the client's normal retry behaviour.
func TestDPDPRequestErasureRetriesTransient503(t *testing.T) {
	var count int32
	body := dpdpFixture(t, "erasure_201")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/dpdp/data-principals/user_123/erasure" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		if atomic.AddInt32(&count, 1) == 1 {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"message":"unavailable"}`))
			return
		}
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer server.Close()
	client := NewClient("test-key", WithBaseURL(server.URL), WithMaxRetries(1))

	res, err := client.DPDP.RequestErasure(context.Background(), "user_123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.RequestID != "ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R" || atomic.LoadInt32(&count) != 2 {
		t.Errorf("expected a retried erasure, requestId=%s requests=%d", res.RequestID, count)
	}
}

func TestDPDPGetsStillRetry503(t *testing.T) {
	var count int32
	body := dpdpFixture(t, "getGrievance_200")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if atomic.AddInt32(&count, 1) == 1 {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"message":"unavailable"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer server.Close()
	client := NewClient("test-key", WithBaseURL(server.URL), WithMaxRetries(1))

	grv, err := client.DPDP.GetGrievance(context.Background(), "grv_01J9ZC5D6E7F8G9H0J1K2M3N4P")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if grv.Status != GrievanceStatusInReview || atomic.LoadInt32(&count) != 2 {
		t.Errorf("expected a retried GET, status=%s requests=%d", grv.Status, count)
	}
}

// ── Errors ───────────────────────────────────────────────────────────────────

func TestDPDPErrorsSurfaceCodeAndRequestID(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		fixture string
		status  int
		invoke  func(*Client) error
	}{
		{"404_NOT_FOUND", 404, func(c *Client) error { _, err := c.DPDP.GetConsentRecord(ctx, "crec_unknown"); return err }},
		{"409_ALREADY_WITHDRAWN", 409, func(c *Client) error {
			_, err := c.DPDP.WithdrawConsent(ctx, "crec_01", WithdrawConsentParams{Reason: "again"})
			return err
		}},
		{"410_GONE", 410, func(c *Client) error { _, err := c.DPDP.GetExport(ctx, "exp_old"); return err }},
		{"409_INVALID_TRANSITION", 409, func(c *Client) error {
			_, err := c.DPDP.UpdateGrievance(ctx, "grv_01", UpdateGrievanceParams{Status: GrievanceStatusInReview})
			return err
		}},
		{"503_CONSENT_PROOF_KEY_NOT_PERSISTENT", 503, func(c *Client) error {
			_, err := c.DPDP.CreateConsentRecord(ctx, CreateConsentRecordParams{
				GrantID: "g", DataPrincipalID: "p", Purposes: []ConsentPurpose{{Code: "c", Description: "d"}},
				ConsentNoticeID: "n", ProcessingExpiresAt: "2027-01-01T00:00:00.000Z",
			})
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.fixture, func(t *testing.T) {
			body := dpdpErrorFixture(t, tc.fixture)
			server, _ := dpdpServer(t, tc.status, body)
			client := NewClient("test-key", WithBaseURL(server.URL))
			err := tc.invoke(client)
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("expected an APIError, got %v", err)
			}
			if apiErr.StatusCode != tc.status || apiErr.Code != body["code"] ||
				apiErr.Message != body["message"] || apiErr.RequestID != body["requestId"] {
				t.Errorf("unexpected error %+v", apiErr)
			}
		})
	}
}

// ── Model tolerance ──────────────────────────────────────────────────────────

func TestDPDPModelsDecodeEveryFixture(t *testing.T) {
	cases := map[string]interface{}{
		"createConsentRecord_201":         &ConsentRecord{},
		"consentRecord_200":               &ConsentRecord{},
		"consentRecord_erased_legacy_200": &ConsentRecord{},
		"listConsentRecords_200":          &ListConsentRecordsResponse{},
		"principalRecords_200":            &PrincipalRecordsResponse{},
		"withdrawConsent_200":             &WithdrawConsentResponse{},
		"createConsentNotice_201":         &ConsentNotice{},
		"listConsentNotices_200":          &ListConsentNoticesResponse{},
		"getConsentNotice_200":            &ConsentNoticeDetail{},
		"fileGrievance_202":               &Grievance{},
		"listGrievances_200":              &ListGrievancesResponse{},
		"getGrievance_200":                &Grievance{},
		"updateGrievance_200":             &Grievance{},
		"createExport_201":                &ComplianceExport{},
		"getExport_200":                   &ComplianceExport{},
		"erasure_201":                     &ErasureResponse{},
	}
	for name, target := range cases {
		raw, _ := json.Marshal(dpdpFixture(t, name))
		if err := json.Unmarshal(raw, target); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}
