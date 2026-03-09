package grantex

import (
	"context"
	"fmt"
)

// BudgetsService handles budget allocation and tracking.
type BudgetsService struct {
	http *httpClient
}

// AllocateBudgetParams contains the parameters for allocating a budget.
type AllocateBudgetParams struct {
	GrantID       string  `json:"grantId"`
	InitialBudget float64 `json:"initialBudget"`
}

// BudgetAllocation represents a budget allocation record.
type BudgetAllocation struct {
	ID              string `json:"id"`
	GrantID         string `json:"grantId"`
	DeveloperID     string `json:"developerId"`
	InitialBudget   string `json:"initialBudget"`
	RemainingBudget string `json:"remainingBudget"`
	Currency        string `json:"currency"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
}

// DebitBudgetParams contains the parameters for debiting a budget.
type DebitBudgetParams struct {
	GrantID     string  `json:"grantId"`
	Amount      float64 `json:"amount"`
	Description string  `json:"description,omitempty"`
}

// DebitBudgetResponse is the response from a budget debit operation.
type DebitBudgetResponse struct {
	Remaining     string `json:"remaining"`
	TransactionID string `json:"transactionId"`
}

// BudgetTransaction represents a single budget transaction.
type BudgetTransaction struct {
	ID           string                 `json:"id"`
	GrantID      string                 `json:"grantId"`
	AllocationID string                 `json:"allocationId"`
	Amount       string                 `json:"amount"`
	Description  string                 `json:"description"`
	Metadata     map[string]interface{} `json:"metadata"`
	CreatedAt    string                 `json:"createdAt"`
}

type listAllocationsResponse struct {
	Allocations []BudgetAllocation `json:"allocations"`
}

type listTransactionsResponse struct {
	Transactions []BudgetTransaction `json:"transactions"`
	Total        int                 `json:"total"`
}

// Allocate creates a new budget allocation for a grant.
func (s *BudgetsService) Allocate(ctx context.Context, params AllocateBudgetParams) (*BudgetAllocation, error) {
	return unmarshal[BudgetAllocation](s.http.post(ctx, "/v1/budget/allocate", params))
}

// Debit debits an amount from a grant's budget.
func (s *BudgetsService) Debit(ctx context.Context, params DebitBudgetParams) (*DebitBudgetResponse, error) {
	return unmarshal[DebitBudgetResponse](s.http.post(ctx, "/v1/budget/debit", params))
}

// Balance retrieves the current budget balance for a grant.
func (s *BudgetsService) Balance(ctx context.Context, grantID string) (*BudgetAllocation, error) {
	return unmarshal[BudgetAllocation](s.http.get(ctx, fmt.Sprintf("/v1/budget/balance/%s", grantID)))
}

// Allocations lists all budget allocations.
func (s *BudgetsService) Allocations(ctx context.Context) ([]BudgetAllocation, error) {
	resp, err := unmarshal[listAllocationsResponse](s.http.get(ctx, "/v1/budget/allocations"))
	if err != nil {
		return nil, err
	}
	return resp.Allocations, nil
}

// Transactions lists budget transactions for a grant.
func (s *BudgetsService) Transactions(ctx context.Context, grantID string) ([]BudgetTransaction, error) {
	resp, err := unmarshal[listTransactionsResponse](s.http.get(ctx, fmt.Sprintf("/v1/budget/transactions/%s", grantID)))
	if err != nil {
		return nil, err
	}
	return resp.Transactions, nil
}
