package grantex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// EventsService handles real-time event streaming.
type EventsService struct {
	http *httpClient
}

// Event represents a server-sent event.
type Event struct {
	Type    string                 `json:"type"`
	Payload map[string]interface{} `json:"payload"`
}

// Stream opens an SSE connection and sends events to the provided channel.
// It blocks until the context is cancelled or the connection is closed.
func (s *EventsService) Stream(ctx context.Context, ch chan<- Event) error {
	req, err := http.NewRequestWithContext(ctx, "GET", s.http.baseURL+"/v1/events/stream", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.http.apiKey)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := s.http.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")
			var evt Event
			if err := json.Unmarshal([]byte(data), &evt); err == nil {
				ch <- evt
			}
		}
	}
	return scanner.Err()
}
