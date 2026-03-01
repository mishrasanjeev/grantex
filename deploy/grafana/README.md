# Grantex Grafana Dashboards

Pre-built Grafana dashboard templates for monitoring a Grantex auth service deployment.

## Dashboards

| File | Description |
|------|-------------|
| `overview-dashboard.json` | System-wide overview: token exchange rate, success rate, latency p50/p99, grants revoked, active grants, webhook deliveries, anomalies, HTTP error rate |
| `per-agent-dashboard.json` | Per-agent drill-down with a `$agent_id` template variable |

## Prerequisites

- Prometheus scraping the Grantex auth service `GET /metrics` endpoint
- Grafana with a Prometheus data source configured

## Import Instructions

1. In Grafana, go to **Dashboards > Import**
2. Upload the JSON file or paste its contents
3. Select your Prometheus data source when prompted (`${DS_PROMETHEUS}`)
4. Click **Import**

## Metrics Exposed

The auth service exposes the following Prometheus metrics at `GET /metrics`:

### Counters
- `grantex_token_exchange_total{status}` — Token exchange attempts (success/error)
- `grantex_authorize_total{status}` — Authorization requests
- `grantex_grants_revoked_total` — Grants revoked (including cascade)
- `grantex_webhook_deliveries_total{status}` — Webhook delivery results
- `grantex_anomalies_detected_total{type,severity}` — Anomalies detected

### Histograms
- `grantex_authorize_duration_seconds` — Authorization request duration
- `grantex_token_exchange_duration_seconds` — Token exchange duration
- `grantex_http_request_duration_seconds{method,route,status_code}` — HTTP request duration

### Gauges
- `grantex_active_grants` — Current active grants count
- `grantex_anomalies_unacknowledged` — Unacknowledged anomalies count

## Alertmanager Rules (Example)

```yaml
groups:
  - name: grantex
    rules:
      - alert: HighTokenExchangeFailureRate
        expr: |
          sum(rate(grantex_token_exchange_total{status!="success"}[5m]))
          / sum(rate(grantex_token_exchange_total[5m])) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Token exchange failure rate > 5%"

      - alert: HighAuthLatency
        expr: |
          histogram_quantile(0.99, rate(grantex_authorize_duration_seconds_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Authorization p99 latency > 2s"
```
