package grantex

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
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

type httpClient struct {
	baseURL       string
	apiKey        string
	client        *http.Client
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
	url := strings.TrimRight(h.baseURL, "/") + path

	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, &NetworkError{Message: "failed to marshal request body", Cause: err}
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, &NetworkError{Message: "failed to create request", Cause: err}
	}

	req.Header.Set("Authorization", "Bearer "+h.apiKey)
	req.Header.Set("User-Agent", "grantex-go/"+sdkVersion)
	if body != nil {
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
