package grantex

import (
	"errors"
	"testing"
)

func TestAPIError(t *testing.T) {
	err := &APIError{
		StatusCode: 400,
		Message:    "bad request",
		Code:       "BAD_REQUEST",
	}
	if err.Error() != "grantex: API error 400: bad request" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
}

func TestAPIErrorNoMessage(t *testing.T) {
	err := &APIError{StatusCode: 500}
	if err.Error() != "grantex: API error 500" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
}

func TestAuthError(t *testing.T) {
	err := &AuthError{APIError: &APIError{
		StatusCode: 401,
		Message:    "unauthorized",
	}}
	if err.Error() != "grantex: auth error 401: unauthorized" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
}

func TestAuthErrorNoMessage(t *testing.T) {
	err := &AuthError{APIError: &APIError{StatusCode: 403}}
	if err.Error() != "grantex: auth error 403" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
}

func TestTokenError(t *testing.T) {
	cause := errors.New("expired")
	err := &TokenError{Message: "verification failed", Cause: cause}

	if err.Error() != "grantex: token error: verification failed: expired" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
	if err.Unwrap() != cause {
		t.Error("Unwrap should return cause")
	}
}

func TestTokenErrorNoCause(t *testing.T) {
	err := &TokenError{Message: "bad token"}
	if err.Error() != "grantex: token error: bad token" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
	if err.Unwrap() != nil {
		t.Error("Unwrap should return nil")
	}
}

func TestNetworkError(t *testing.T) {
	cause := errors.New("connection refused")
	err := &NetworkError{Message: "request failed", Cause: cause}

	if err.Error() != "grantex: network error: request failed: connection refused" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
	if err.Unwrap() != cause {
		t.Error("Unwrap should return cause")
	}
}

func TestNetworkErrorNoCause(t *testing.T) {
	err := &NetworkError{Message: "timeout"}
	if err.Error() != "grantex: network error: timeout" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
}

func TestErrorInterfaces(t *testing.T) {
	// Verify all error types implement error interface
	var _ error = &APIError{}
	var _ error = &AuthError{}
	var _ error = &TokenError{}
	var _ error = &NetworkError{}

	// Verify Unwrap interface
	var _ interface{ Unwrap() error } = &TokenError{}
	var _ interface{ Unwrap() error } = &NetworkError{}
}
