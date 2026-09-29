package grantex

import "testing"

// forgetJwksOnCleanup drops jwksURI from the process-wide JWKS cache when the
// test ends. Test servers get fresh keys but reuse kids such as "ec-1", and a
// later httptest server can be given the same 127.0.0.1 port: without this,
// that test would be served the earlier test's cached key set and fail with
// an invalid signature. Production code never unregisters a URL.
func forgetJwksOnCleanup(t *testing.T, jwksURI string) {
	t.Helper()
	t.Cleanup(func() {
		jwksRefreshMu.Lock()
		defer jwksRefreshMu.Unlock()
		delete(jwksLastRefresh, jwksURI)
		cache := getJwksCache()
		if cache.IsRegistered(jwksURI) {
			if err := cache.Unregister(jwksURI); err != nil {
				t.Errorf("unregister %s from the JWKS cache: %v", jwksURI, err)
			}
		}
	})
}
