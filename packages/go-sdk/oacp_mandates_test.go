package grantex

// VerifyOacpMandate and CheckOacpMandateChain against the shared mandate
// vectors (spec/examples/oacp/oacp-mandates-v1.json and
// oacp-mandates-v1-extra.json), the files the auth service and the
// TypeScript and Python SDKs also run.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type oacpMandateVectors struct {
	Issuer           string          `json:"issuer"`
	VerifyAt         int64           `json:"verify_at"`
	ExpectedAudience string          `json:"expected_audience"`
	JWKS             json.RawMessage `json:"jwks"`
	Checkout         json.RawMessage `json:"checkout"`
	CheckoutHash     string          `json:"checkout_hash"`
	Cases            []struct {
		Name             string          `json:"name"`
		Mandate          string          `json:"mandate"`
		ExpectedType     string          `json:"expected_type"`
		ExpectedAudience string          `json:"expected_audience"`
		Status           json.RawMessage `json:"status"`
		Expect           *string         `json:"expect"`
	} `json:"cases"`
	Chains []struct {
		Name    string  `json:"name"`
		Intent  string  `json:"intent"`
		Cart    string  `json:"cart"`
		Payment string  `json:"payment"`
		Expect  *string `json:"expect"`
	} `json:"chains"`
}

func loadOacpMandateVectors(t *testing.T, name string) oacpMandateVectors {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "spec", "examples", "oacp", name))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v oacpMandateVectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return v
}

func runOacpMandateCases(t *testing.T, v oacpMandateVectors) {
	for _, c := range v.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			status := 0
			if len(c.Status) > 0 {
				if err := json.Unmarshal(c.Status, &status); err != nil {
					status = -1 // "unavailable"
				}
			}
			audience := v.ExpectedAudience
			if c.ExpectedAudience != "" {
				audience = c.ExpectedAudience
			}
			r := VerifyOacpMandate(context.Background(), c.Mandate, OacpMandateVerifyOptions{
				Issuer: v.Issuer, JWKS: v.JWKS, Now: time.Unix(v.VerifyAt, 0),
				ExpectedType: OacpMandateType(c.ExpectedType), ExpectedAudience: audience, Status: &status,
			})
			if c.Expect == nil {
				if !r.Valid || r.Status != "valid" || r.MandateHash != OacpMandateHash(c.Mandate) {
					t.Fatalf("want valid, got %+v", r)
				}
				return
			}
			if r.Valid || string(r.RefusalCode) != *c.Expect {
				t.Fatalf("want %s, got valid=%v code=%s (%s)", *c.Expect, r.Valid, r.RefusalCode, r.Message)
			}
		})
	}
}

func TestOacpMandateVectors(t *testing.T) {
	v := loadOacpMandateVectors(t, "oacp-mandates-v1.json")
	hash, err := OacpCheckoutHash(v.Checkout)
	if err != nil || hash != v.CheckoutHash {
		t.Fatalf("checkout hash %q, %v; want %q", hash, err, v.CheckoutHash)
	}
	runOacpMandateCases(t, v)
	for _, chain := range v.Chains {
		chain := chain
		t.Run("chain_"+chain.Name, func(t *testing.T) {
			claims := func(m string) map[string]any {
				if m == "" {
					return nil
				}
				r := VerifyOacpMandate(context.Background(), m, OacpMandateVerifyOptions{
					Issuer: v.Issuer, JWKS: v.JWKS, Now: time.Unix(v.VerifyAt, 0), SkipStatusCheck: true,
				})
				if !r.Valid {
					t.Fatalf("chain member refused: %s", r.RefusalCode)
				}
				return r.Claims
			}
			got := CheckOacpMandateChain(claims(chain.Intent), claims(chain.Cart), claims(chain.Payment))
			want := ""
			if chain.Expect != nil {
				want = *chain.Expect
			}
			if string(got) != want {
				t.Fatalf("chain: want %q, got %q", want, got)
			}
		})
	}
}

func TestOacpMandateExtraVectors(t *testing.T) {
	runOacpMandateCases(t, loadOacpMandateVectors(t, "oacp-mandates-v1-extra.json"))
}

func TestOacpMandateStatusFailsClosed(t *testing.T) {
	v := loadOacpMandateVectors(t, "oacp-mandates-v1.json")
	r := VerifyOacpMandate(context.Background(), v.Cases[0].Mandate, OacpMandateVerifyOptions{
		Issuer: v.Issuer, JWKS: v.JWKS, Now: time.Unix(v.VerifyAt, 0),
	})
	if r.Valid || r.RefusalCode != OacpMandateStatusUnavailable {
		t.Fatalf("want revocation_status_unavailable without a fetcher, got %+v", r)
	}
	r = VerifyOacpMandate(context.Background(), v.Cases[0].Mandate, OacpMandateVerifyOptions{
		Issuer: v.Issuer, JWKS: v.JWKS, Now: time.Unix(v.VerifyAt, 0),
		StatusListFetcher: func(context.Context, string) (string, error) { return "not-a-token", nil },
	})
	if r.Valid || r.RefusalCode != OacpMandateStatusUnavailable {
		t.Fatalf("want revocation_status_unavailable for an unreadable list, got %+v", r)
	}
}
