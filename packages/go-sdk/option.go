package grantex

import (
	"net/http"
	"time"
)

type clientConfig struct {
	baseURL    string
	timeout    time.Duration
	httpClient *http.Client
}

// Option configures a Grantex client.
type Option func(*clientConfig)

// WithBaseURL sets the API base URL. Defaults to "https://api.grantex.dev".
func WithBaseURL(url string) Option {
	return func(c *clientConfig) {
		c.baseURL = url
	}
}

// WithTimeout sets the HTTP request timeout. Defaults to 30 seconds.
func WithTimeout(d time.Duration) Option {
	return func(c *clientConfig) {
		c.timeout = d
	}
}

// WithHTTPClient sets a custom http.Client for requests.
func WithHTTPClient(client *http.Client) Option {
	return func(c *clientConfig) {
		c.httpClient = client
	}
}
