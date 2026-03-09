package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBudgetsAllocate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/budget/allocate" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params AllocateBudgetParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.GrantID != "grant-1" {
			t.Errorf("expected grantId grant-1, got %s", params.GrantID)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(BudgetAllocation{
			ID:              "alloc-1",
			GrantID:         "grant-1",
			DeveloperID:     "dev-1",
			InitialBudget:   "100.00",
			RemainingBudget: "100.00",
			Currency:        "USD",
			CreatedAt:       "2026-03-01T00:00:00Z",
			UpdatedAt:       "2026-03-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	alloc, err := client.Budgets.Allocate(context.Background(), AllocateBudgetParams{
		GrantID:       "grant-1",
		InitialBudget: 100.00,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if alloc.ID != "alloc-1" {
		t.Errorf("expected alloc-1, got %s", alloc.ID)
	}
	if alloc.InitialBudget != "100.00" {
		t.Errorf("expected 100.00, got %s", alloc.InitialBudget)
	}
}

func TestBudgetsDebit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/budget/debit" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(DebitBudgetResponse{
			Remaining:     "90.00",
			TransactionID: "tx-1",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Budgets.Debit(context.Background(), DebitBudgetParams{
		GrantID:     "grant-1",
		Amount:      10.00,
		Description: "API call",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Remaining != "90.00" {
		t.Errorf("expected 90.00, got %s", result.Remaining)
	}
	if result.TransactionID != "tx-1" {
		t.Errorf("expected tx-1, got %s", result.TransactionID)
	}
}

func TestBudgetsBalance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/budget/balance/grant-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(BudgetAllocation{
			ID:              "alloc-1",
			GrantID:         "grant-1",
			InitialBudget:   "100.00",
			RemainingBudget: "75.50",
			Currency:        "USD",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	alloc, err := client.Budgets.Balance(context.Background(), "grant-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if alloc.RemainingBudget != "75.50" {
		t.Errorf("expected 75.50, got %s", alloc.RemainingBudget)
	}
}

func TestBudgetsAllocations(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/budget/allocations" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(listAllocationsResponse{
			Allocations: []BudgetAllocation{
				{ID: "alloc-1", GrantID: "grant-1"},
				{ID: "alloc-2", GrantID: "grant-2"},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	allocs, err := client.Budgets.Allocations(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(allocs) != 2 {
		t.Errorf("expected 2 allocations, got %d", len(allocs))
	}
}

func TestBudgetsTransactions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/budget/transactions/grant-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(listTransactionsResponse{
			Transactions: []BudgetTransaction{
				{ID: "tx-1", GrantID: "grant-1", Amount: "10.00"},
				{ID: "tx-2", GrantID: "grant-1", Amount: "5.00"},
			},
			Total: 2,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	txns, err := client.Budgets.Transactions(context.Background(), "grant-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(txns) != 2 {
		t.Errorf("expected 2 transactions, got %d", len(txns))
	}
	if txns[0].Amount != "10.00" {
		t.Errorf("expected 10.00, got %s", txns[0].Amount)
	}
}
