package grantex

// Network sources for VerifyOacpArtifact: the issuer's JWK Set and its Token
// Status Lists. Both are bound to URLs the relying party configures; neither
// ever follows a URL taken from an artifact outside those bounds, and
// neither follows redirects.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// OacpFetchTimeout is the deadline for one fetch, headers and body.
	OacpFetchTimeout = 5 * time.Second
	// OacpJWKSMaxBytes is the largest JWK Set read.
	OacpJWKSMaxBytes = 64 * 1024
	// OacpStatusListMaxBytes is the largest Status List Token read.
	OacpStatusListMaxBytes = 1024 * 1024
	// OacpJWKSCacheDuration is the longest a JWK Set is reused before it is
	// fetched again.
	OacpJWKSCacheDuration = 10 * time.Minute
	// OacpJWKSRefreshCooldown is how often, at most, an unknown kid refetches
	// the JWK Set.
	OacpJWKSRefreshCooldown = 30 * time.Second
	// OacpStatusListMaxCacheSeconds is the longest a Status List Token is
	// reused, whatever its ttl.
	OacpStatusListMaxCacheSeconds = 600
)

const oacpAcceptHeader = "application/json, application/jwk-set+json, application/statuslist+jwt"

// oacpNoRedirectClient copies client (or http.DefaultClient) so that it
// returns a redirect response instead of following it.
func oacpNoRedirectClient(client *http.Client) *http.Client {
	if client == nil {
		client = http.DefaultClient
	}
	c := *client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &c
}

// oacpMediaType is the media type of a Content-Type value, lowercased.
func oacpMediaType(contentType string) string {
	mt, _, _ := strings.Cut(strings.ToLower(contentType), ";")
	return oacpTrimJS(mt)
}

func oacpBoundedText(ctx context.Context, client *http.Client, target string, maxBytes int64, accept func(string) bool) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, OacpFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", oacpAcceptHeader)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s answered HTTP %d", target, resp.StatusCode)
	}
	if !accept(oacpMediaType(resp.Header.Get("Content-Type"))) {
		return "", fmt.Errorf("%s answered an unexpected content type", target)
	}
	if resp.ContentLength > maxBytes {
		return "", fmt.Errorf("%s is larger than %d bytes", target, maxBytes)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return "", err
	}
	if int64(len(body)) > maxBytes {
		return "", fmt.Errorf("%s is larger than %d bytes", target, maxBytes)
	}
	if !utf8.Valid(body) {
		return "", fmt.Errorf("%s answered text that is not UTF-8", target)
	}
	// A UTF-8 decoder strips a leading byte order mark, as TextDecoder does.
	return string(bytes.TrimPrefix(body, []byte("\xEF\xBB\xBF"))), nil
}

// oacpHref writes a URL in the normalized form a WHATWG URL's href has for
// the cases that matter here: lowercase scheme and host, no default port,
// and "/" for an empty path.
func oacpHref(u *url.URL) string {
	c := *u
	c.Scheme = strings.ToLower(c.Scheme)
	host := strings.ToLower(c.Host)
	if c.Scheme == "https" {
		host = strings.TrimSuffix(host, ":443")
	} else if c.Scheme == "http" {
		host = strings.TrimSuffix(host, ":80")
	}
	c.Host = host
	if c.Path == "" && c.RawPath == "" {
		c.Path = "/"
	}
	return c.String()
}

func oacpRequireHTTPS(value string, allowLoopbackHTTP bool, what string) (*url.URL, error) {
	u, ok := oacpParseHTTPURL(value)
	if !ok {
		return nil, fmt.Errorf("%s is not a valid URL", what)
	}
	if u.Scheme == "https" {
		return u, nil
	}
	if allowLoopbackHTTP && u.Scheme == "http" && oacpIsLoopbackHost(u.Hostname()) {
		return u, nil
	}
	return nil, fmt.Errorf("%s must be an https URL", what)
}

// OacpJWKSFetcherOptions configures NewOacpJWKSFetcher.
type OacpJWKSFetcherOptions struct {
	// JWKSURI is where the issuer's JWK Set is served. Default
	// <issuer>/.well-known/jwks.json.
	JWKSURI string
	// AllowLoopbackHTTP accepts plain http on loopback hosts (local
	// development only).
	AllowLoopbackHTTP bool
	// HTTPClient is copied and used without redirect following. Default
	// http.DefaultClient.
	HTTPClient *http.Client
}

// NewOacpJWKSFetcher returns a JWK Set source bound to the pinned issuer's
// JWKS URI, for OacpVerifyOptions.JWKSFetcher: cached for ten minutes,
// refetched for an unknown kid at most every 30 seconds, HTTP 200 only,
// application/json or application/jwk-set+json, at most 64 KiB, no
// redirects.
func NewOacpJWKSFetcher(issuer string, opts OacpJWKSFetcherOptions) (func(ctx context.Context, refresh bool) (json.RawMessage, error), error) {
	return newOacpJWKSFetcher(issuer, opts, time.Now)
}

func newOacpJWKSFetcher(issuer string, opts OacpJWKSFetcherOptions, clock func() time.Time) (func(ctx context.Context, refresh bool) (json.RawMessage, error), error) {
	issuerURL, err := oacpRequireHTTPS(issuer, opts.AllowLoopbackHTTP, "issuer")
	if err != nil {
		return nil, err
	}
	raw := opts.JWKSURI
	if raw == "" {
		raw = strings.TrimRight(oacpHref(issuerURL), "/") + "/.well-known/jwks.json"
	}
	jwksURL, err := oacpRequireHTTPS(raw, opts.AllowLoopbackHTTP, "JWKSURI")
	if err != nil {
		return nil, err
	}
	jwksURI := oacpHref(jwksURL)
	client := oacpNoRedirectClient(opts.HTTPClient)

	var (
		mu       sync.Mutex
		cached   json.RawMessage
		cachedAt time.Time
	)
	return func(ctx context.Context, refresh bool) (json.RawMessage, error) {
		if ctx == nil {
			ctx = context.Background()
		}
		now := clock()
		mu.Lock()
		if cached != nil {
			age := now.Sub(cachedAt)
			fresh := age < OacpJWKSCacheDuration
			mayRefresh := age >= OacpJWKSRefreshCooldown
			if fresh && !(refresh && mayRefresh) {
				out := cached
				mu.Unlock()
				return out, nil
			}
		}
		mu.Unlock()
		text, err := oacpBoundedText(ctx, client, jwksURI, OacpJWKSMaxBytes, func(mt string) bool {
			return mt == "application/json" || mt == "application/jwk-set+json"
		})
		if err != nil {
			return nil, err
		}
		parsed, err := parseOacpJSON([]byte(text), true)
		if err != nil {
			return nil, fmt.Errorf("%s is not JSON: %w", jwksURI, err)
		}
		set, ok := oacpAsObject(parsed)
		if ok {
			keys, _ := set.get("keys")
			_, ok = keys.([]any)
		}
		if !ok {
			return nil, fmt.Errorf("%s is not a JWK Set", jwksURI)
		}
		out := json.RawMessage(text)
		mu.Lock()
		cached, cachedAt = out, now
		mu.Unlock()
		return out, nil
	}, nil
}

// OacpStatusListFetcherOptions configures NewOacpStatusListFetcher.
type OacpStatusListFetcherOptions struct {
	// AllowedPrefixes are the URI prefixes trusted to serve status lists,
	// normally <issuer>/status/oacp/. A status URI outside them is refused.
	AllowedPrefixes []string
	// AllowLoopbackHTTP accepts plain http on loopback hosts (local
	// development only).
	AllowLoopbackHTTP bool
	// MaxCacheSeconds caps how long a list is reused (never longer than its
	// ttl). nil means OacpStatusListMaxCacheSeconds; 0 disables reuse.
	MaxCacheSeconds *int
	// HTTPClient is copied and used without redirect following. Default
	// http.DefaultClient.
	HTTPClient *http.Client
}

type oacpCachedStatusList struct {
	token string
	until time.Time
}

// OacpStatusListFetcher fetches Token Status Lists from the configured
// prefixes. It caches each list for no longer than the list's ttl
// (draft-ietf-oauth-status-list §13.7); the verifier still checks the
// signature and freshness of every copy, so a cached list never outlives its
// exp. It is safe for concurrent use.
type OacpStatusListFetcher struct {
	prefixes          []string
	allowLoopbackHTTP bool
	maxCacheSeconds   int
	client            *http.Client
	now               func() time.Time

	mu    sync.Mutex
	cache map[string]oacpCachedStatusList
}

// NewOacpStatusListFetcher returns a status-list source restricted to
// opts.AllowedPrefixes. Pass its Fetch method as
// OacpVerifyOptions.StatusListFetcher.
func NewOacpStatusListFetcher(opts OacpStatusListFetcherOptions) (*OacpStatusListFetcher, error) {
	prefixes := make([]string, 0, len(opts.AllowedPrefixes))
	for _, p := range opts.AllowedPrefixes {
		u, err := oacpRequireHTTPS(p, opts.AllowLoopbackHTTP, "allowed prefix")
		if err != nil {
			return nil, err
		}
		prefixes = append(prefixes, oacpHref(u))
	}
	if len(prefixes) == 0 {
		return nil, errors.New("NewOacpStatusListFetcher needs at least one allowed prefix")
	}
	maxCache := OacpStatusListMaxCacheSeconds
	if opts.MaxCacheSeconds != nil {
		maxCache = *opts.MaxCacheSeconds
	}
	return &OacpStatusListFetcher{
		prefixes:          prefixes,
		allowLoopbackHTTP: opts.AllowLoopbackHTTP,
		maxCacheSeconds:   maxCache,
		client:            oacpNoRedirectClient(opts.HTTPClient),
		now:               time.Now,
		cache:             map[string]oacpCachedStatusList{},
	}, nil
}

// Fetch returns the Status List Token text served at uri.
func (f *OacpStatusListFetcher) Fetch(ctx context.Context, uri string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	u, err := oacpRequireHTTPS(uri, f.allowLoopbackHTTP, "status list URI")
	if err != nil {
		return "", err
	}
	hasCredentials := u.User != nil && (u.User.Username() != "" || oacpHasPassword(u.User))
	if u.RawQuery != "" || u.Fragment != "" || hasCredentials {
		return "", errors.New("status list URI must not carry a query, fragment or credentials")
	}
	// A dot segment (RFC 3986 §5.2.4, also percent-encoded) would let a URI
	// that starts with an allowed prefix resolve outside it. u.Path is
	// already percent-decoded.
	for _, segment := range strings.Split(u.Path, "/") {
		if segment == "." || segment == ".." {
			return "", errors.New("status list URI must not carry dot segments")
		}
	}
	href := oacpHref(u)
	allowed := false
	for _, p := range f.prefixes {
		if strings.HasPrefix(href, p) {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", errors.New("status list URI is outside the configured issuer prefixes")
	}
	f.mu.Lock()
	hit, ok := f.cache[href]
	f.mu.Unlock()
	if ok && hit.until.After(f.now()) {
		return hit.token, nil
	}
	text, err := oacpBoundedText(ctx, f.client, href, OacpStatusListMaxBytes, func(mt string) bool {
		return mt == OacpStatusListTokenMediaType
	})
	if err != nil {
		return "", err
	}
	token := oacpTrimJS(text)
	now := f.now()
	ttl, ok := oacpUnverifiedTTLSeconds(token, now)
	f.mu.Lock()
	if ok && f.maxCacheSeconds > 0 {
		keep := ttl
		if int64(f.maxCacheSeconds) < keep {
			keep = int64(f.maxCacheSeconds)
		}
		f.cache[href] = oacpCachedStatusList{token: token, until: now.Add(time.Duration(keep) * time.Second)}
	} else {
		delete(f.cache, href)
	}
	f.mu.Unlock()
	return token, nil
}

// Clear drops every cached list.
func (f *OacpStatusListFetcher) Clear() {
	f.mu.Lock()
	f.cache = map[string]oacpCachedStatusList{}
	f.mu.Unlock()
}

func oacpHasPassword(u *url.Userinfo) bool {
	p, set := u.Password()
	return set && p != ""
}

// oacpUnverifiedTTLSeconds reads how long a token may be cached from its
// unverified claims: its ttl, capped by the time left before its exp. The
// verifier checks the token itself on every use.
func oacpUnverifiedTTLSeconds(token string, now time.Time) (int64, bool) {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return 0, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return 0, false
	}
	v, err := parseOacpJSON(raw, true)
	if err != nil {
		return 0, false
	}
	claims, ok := oacpAsObject(v)
	if !ok {
		return 0, false
	}
	ttlValue, _ := claims.get("ttl")
	ttl, ok := oacpSafeInteger(ttlValue)
	if !ok || ttl <= 0 {
		return 0, false
	}
	if expValue, present := claims.get("exp"); present {
		if exp, isNum := expValue.(oacpNumber); isNum {
			left := math.Floor(exp.value - float64(now.UnixMilli())/1000)
			if left < 0 {
				left = 0
			}
			if left < float64(ttl) {
				return int64(left), true
			}
		}
	}
	return ttl, true
}
