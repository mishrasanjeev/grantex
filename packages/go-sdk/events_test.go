package grantex

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEventsStream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/events/stream" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Accept") != "text/event-stream" {
			t.Errorf("expected Accept: text/event-stream, got %s", r.Header.Get("Accept"))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("expected http.Flusher")
		}
		fmt.Fprintf(w, "data: {\"type\":\"grant.created\",\"payload\":{\"grantId\":\"g-1\"}}\n\n")
		flusher.Flush()
		fmt.Fprintf(w, "data: {\"type\":\"token.exchanged\",\"payload\":{\"tokenId\":\"t-1\"}}\n\n")
		flusher.Flush()
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	ch := make(chan Event, 10)

	err := client.Events.Stream(context.Background(), ch)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(ch) != 2 {
		t.Fatalf("expected 2 events, got %d", len(ch))
	}

	evt1 := <-ch
	if evt1.Type != "grant.created" {
		t.Errorf("expected grant.created, got %s", evt1.Type)
	}

	evt2 := <-ch
	if evt2.Type != "token.exchanged" {
		t.Errorf("expected token.exchanged, got %s", evt2.Type)
	}
}

func TestEventsStreamUnauthorized(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := NewClient("bad-key", WithBaseURL(server.URL))
	ch := make(chan Event, 10)

	err := client.Events.Stream(context.Background(), ch)
	if err == nil {
		t.Fatal("expected error for unauthorized request")
	}
}
