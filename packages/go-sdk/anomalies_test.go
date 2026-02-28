package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAnomaliesDetect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/anomalies/detect" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(DetectAnomaliesResponse{
			DetectedAt: "2026-03-01T00:00:00Z",
			Total:      1,
			Anomalies: []Anomaly{{
				ID:          "anom-1",
				Type:        "rate_spike",
				Severity:    "high",
				Description: "Unusual rate spike detected",
				DetectedAt:  "2026-03-01T00:00:00Z",
			}},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Anomalies.Detect(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 1 {
		t.Errorf("expected 1, got %d", result.Total)
	}
	if result.Anomalies[0].Type != "rate_spike" {
		t.Errorf("expected rate_spike, got %s", result.Anomalies[0].Type)
	}
}

func TestAnomaliesList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/anomalies" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListAnomaliesResponse{
			Anomalies: []Anomaly{{ID: "anom-1"}, {ID: "anom-2"}},
			Total:     2,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Anomalies.List(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 2 {
		t.Errorf("expected 2, got %d", result.Total)
	}
}

func TestAnomaliesListUnacknowledged(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("unacknowledged") != "true" {
			t.Errorf("expected unacknowledged=true")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListAnomaliesResponse{
			Anomalies: []Anomaly{{ID: "anom-1"}},
			Total:     1,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	unack := true
	result, err := client.Anomalies.List(context.Background(), &ListAnomaliesParams{
		Unacknowledged: &unack,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 1 {
		t.Errorf("expected 1, got %d", result.Total)
	}
}

func TestAnomaliesAcknowledge(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/anomalies/anom-1/acknowledge" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		ack := "2026-03-01T00:00:00Z"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Anomaly{
			ID:             "anom-1",
			AcknowledgedAt: &ack,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	anom, err := client.Anomalies.Acknowledge(context.Background(), "anom-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if anom.AcknowledgedAt == nil {
		t.Error("expected acknowledgedAt to be set")
	}
}
