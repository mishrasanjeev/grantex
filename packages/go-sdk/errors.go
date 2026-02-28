package grantex

import (
	"encoding/json"
	"fmt"
)

// APIError represents a non-2xx HTTP response from the Grantex API.
type APIError struct {
	StatusCode int
	Body       json.RawMessage
	Code       string
	RequestID  string
	Message    string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("grantex: API error %d: %s", e.StatusCode, e.Message)
	}
	return fmt.Sprintf("grantex: API error %d", e.StatusCode)
}

// AuthError represents a 401 or 403 response.
type AuthError struct {
	*APIError
}

func (e *AuthError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("grantex: auth error %d: %s", e.StatusCode, e.Message)
	}
	return fmt.Sprintf("grantex: auth error %d", e.StatusCode)
}

// TokenError represents a token verification or decoding error.
type TokenError struct {
	Message string
	Cause   error
}

func (e *TokenError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("grantex: token error: %s: %v", e.Message, e.Cause)
	}
	return fmt.Sprintf("grantex: token error: %s", e.Message)
}

func (e *TokenError) Unwrap() error {
	return e.Cause
}

// NetworkError represents a network-level failure (DNS, timeout, connection refused).
type NetworkError struct {
	Message string
	Cause   error
}

func (e *NetworkError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("grantex: network error: %s: %v", e.Message, e.Cause)
	}
	return fmt.Sprintf("grantex: network error: %s", e.Message)
}

func (e *NetworkError) Unwrap() error {
	return e.Cause
}
