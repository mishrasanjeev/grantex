package grantex

import "context"

// AnomaliesService handles anomaly detection and management.
type AnomaliesService struct {
	http *httpClient
}

// Detect triggers anomaly detection and returns results.
func (s *AnomaliesService) Detect(ctx context.Context) (*DetectAnomaliesResponse, error) {
	return unmarshal[DetectAnomaliesResponse](s.http.post(ctx, "/v1/anomalies/detect", nil))
}

// List retrieves anomalies with optional filters.
func (s *AnomaliesService) List(ctx context.Context, params *ListAnomaliesParams) (*ListAnomaliesResponse, error) {
	path := "/v1/anomalies"
	if params != nil && params.Unacknowledged != nil {
		q := make(map[string]string)
		if *params.Unacknowledged {
			q["unacknowledged"] = "true"
		} else {
			q["unacknowledged"] = "false"
		}
		path += buildQueryString(q)
	}
	return unmarshal[ListAnomaliesResponse](s.http.get(ctx, path))
}

// Acknowledge marks an anomaly as acknowledged.
func (s *AnomaliesService) Acknowledge(ctx context.Context, anomalyID string) (*Anomaly, error) {
	return unmarshal[Anomaly](s.http.post(ctx, "/v1/anomalies/"+anomalyID+"/acknowledge", nil))
}
