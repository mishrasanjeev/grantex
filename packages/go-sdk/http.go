package grantex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const sdkVersion = "0.1.0"

func parseRateLimitHeaders(header http.Header) *RateLimit {
	limitStr := header.Get("X-RateLimit-Limit")
	remainingStr := header.Get("X-RateLimit-Remaining")
	resetStr := header.Get("X-RateLimit-Reset")

	if limitStr == "" || remainingStr == "" || resetStr == "" {
		return nil
	}

	limit, err1 := strconv.Atoi(limitStr)
	remaining, err2 := strconv.Atoi(remainingStr)
	reset, err3 := strconv.ParseInt(resetStr, 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return nil
	}

	rl := &RateLimit{
		Limit:     limit,
		Remaining: remaining,
		Reset:     reset,
	}

	if ra := header.Get("Retry-After"); ra != "" {
		if v, err := strconv.Atoi(ra); err == nil {
			rl.RetryAfter = v
		}
	}

	return rl
}

const (
	defaultMaxRetries = 3
	retryBaseDelay    = 500 * time.Millisecond
	retryMaxDelay     = 10 * time.Second
)

type httpClient struct {
	baseURL       string
	apiKey        string
	client        *http.Client
	maxRetries    int
	maxRetriesSet bool
	lastRateLimit *RateLimit
}

func (h *httpClient) get(ctx context.Context, path string) ([]byte, error) {
	return h.do(ctx, http.MethodGet, path, nil)
}

func (h *httpClient) post(ctx context.Context, path string, body interface{}) ([]byte, error) {
	return h.do(ctx, http.MethodPost, path, body)
}

func (h *httpClient) put(ctx context.Context, path string, body interface{}) ([]byte, error) {
	return h.do(ctx, http.MethodPut, path, body)
}

func (h *httpClient) patch(ctx context.Context, path string, body interface{}) ([]byte, error) {
	return h.do(ctx, http.MethodPatch, path, body)
}

func (h *httpClient) del(ctx context.Context, path string) ([]byte, error) {
	return h.do(ctx, http.MethodDelete, path, nil)
}

func (h *httpClient) do(ctx context.Context, method, path string, body interface{}) ([]byte, error) {
	maxRetries := h.maxRetries
	if !h.maxRetriesSet {
		maxRetries = defaultMaxRetries
	}

	// Pre-marshal the body so we can replay it on retries.
	var bodyBytes []byte
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, &NetworkError{Message: "failed to marshal request body", Cause: err}
		}
		bodyBytes = data
	}

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			delay := h.retryDelay(attempt-1, lastErr)
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, &NetworkError{Message: "request cancelled during retry backoff", Cause: ctx.Err()}
			case <-timer.C:
			}
		}

		respBody, err := h.doOnce(ctx, method, path, bodyBytes)
		if err == nil {
			return respBody, nil
		}

		if !isRetryable(err) {
			return nil, err
		}
		lastErr = err
	}

	return nil, lastErr
}

// isRetryable returns true for transient failures that should be retried.
func isRetryable(err error) bool {
	// Network errors (connection refused, timeout, DNS failures) are retryable.
	var netErr *NetworkError
	if errors.As(err, &netErr) {
		return true
	}

	// Retry specific HTTP status codes: 429, 502, 503, 504.
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case http.StatusTooManyRequests, // 429
			http.StatusBadGateway,      // 502
			http.StatusServiceUnavailable, // 503
			http.StatusGatewayTimeout:  // 504
			return true
		}
	}

	// AuthError wraps APIError but should NOT be retried (401, 403).
	return false
}

// retryDelay computes the backoff delay: min(baseDelay * 2^attempt + jitter, maxDelay).
// If the last error carried a Retry-After header, that value is used instead.
func (h *httpClient) retryDelay(attempt int, lastErr error) time.Duration {
	// Respect Retry-After header from 429 responses.
	var apiErr *APIError
	if errors.As(lastErr, &apiErr) && apiErr.RateLimit != nil && apiErr.RateLimit.RetryAfter > 0 {
		d := time.Duration(apiErr.RateLimit.RetryAfter) * time.Second
		if d > retryMaxDelay {
			d = retryMaxDelay
		}
		return d
	}

	exp := math.Pow(2, float64(attempt))
	delay := time.Duration(float64(retryBaseDelay) * exp)
	jitter := time.Duration(rand.Int63n(int64(retryBaseDelay)))
	delay += jitter
	if delay > retryMaxDelay {
		delay = retryMaxDelay
	}
	return delay
}

// doOnce executes a single HTTP request (no retries).
func (h *httpClient) doOnce(ctx context.Context, method, path string, bodyBytes []byte) ([]byte, error) {
	url := strings.TrimRight(h.baseURL, "/") + path

	var bodyReader io.Reader
	if bodyBytes != nil {
		bodyReader = bytes.NewReader(bodyBytes)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, &NetworkError{Message: "failed to create request", Cause: err}
	}

	req.Header.Set("Authorization", "Bearer "+h.apiKey)
	req.Header.Set("User-Agent", "grantex-go/"+sdkVersion)
	if bodyBytes != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := h.client.Do(req)
	if err != nil {
		return nil, &NetworkError{Message: "request failed", Cause: err}
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &NetworkError{Message: "failed to read response body", Cause: err}
	}

	h.lastRateLimit = parseRateLimitHeaders(resp.Header)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if resp.StatusCode == http.StatusNoContent || len(respBody) == 0 {
			return nil, nil
		}
		return respBody, nil
	}

	return nil, h.parseError(resp.StatusCode, respBody, h.lastRateLimit)
}

func (h *httpClient) parseError(statusCode int, body []byte, rl *RateLimit) error {
	apiErr := &APIError{
		StatusCode: statusCode,
		Body:       json.RawMessage(body),
		RateLimit:  rl,
	}

	var parsed struct {
		Error     string `json:"error"`
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(body, &parsed) == nil {
		if parsed.Message != "" {
			apiErr.Message = parsed.Message
		} else if parsed.Error != "" {
			apiErr.Message = parsed.Error
		}
		apiErr.Code = parsed.Code
		apiErr.RequestID = parsed.RequestID
	} else {
		apiErr.Message = string(body)
	}

	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		return &AuthError{APIError: apiErr}
	}

	return apiErr
}

func unmarshal[T any](data []byte, err error) (*T, error) {
	if err != nil {
		return nil, err
	}
	if data == nil {
		return nil, nil
	}
	var result T
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, &NetworkError{Message: fmt.Sprintf("failed to decode response: %s", string(data)), Cause: err}
	}
	return &result, nil
}

func unmarshalSlice[T any](data []byte, err error) ([]T, error) {
	if err != nil {
		return nil, err
	}
	if data == nil {
		return nil, nil
	}
	var result []T
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, &NetworkError{Message: fmt.Sprintf("failed to decode response: %s", string(data)), Cause: err}
	}
	return result, nil
}

func buildQueryString(params map[string]string) string {
	if len(params) == 0 {
		return ""
	}
	var parts []string
	for k, v := range params {
		if v != "" {
			parts = append(parts, k+"="+v)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "?" + strings.Join(parts, "&")
}
