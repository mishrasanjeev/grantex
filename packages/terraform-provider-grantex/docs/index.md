# Grantex Provider

The Grantex provider is used to manage [Grantex](https://grantex.dev) resources for delegated authorization of AI agents. It provides infrastructure-as-code management for agents, policies, webhooks, SSO configurations, and budget allocations.

## Example Usage

```hcl
terraform {
  required_providers {
    grantex = {
      source  = "mishrasanjeev/grantex"
      version = "~> 0.1"
    }
  }
}

provider "grantex" {
  api_key = var.grantex_api_key
}

resource "grantex_agent" "my_agent" {
  name        = "My AI Agent"
  description = "An agent that manages calendar events"
  scopes      = ["calendar:read", "calendar:write"]
}
```

## Authentication

The provider requires an API key to authenticate with the Grantex API. You can configure it in one of two ways:

1. Set the `api_key` attribute in the provider configuration block.
2. Set the `GRANTEX_API_KEY` environment variable.

If both are set, the provider configuration takes precedence.

## Schema

### Optional

- `api_key` (String, Sensitive) - The API key for authenticating with the Grantex API. Can also be set via the `GRANTEX_API_KEY` environment variable.
- `base_url` (String) - The base URL for the Grantex API. Defaults to `https://api.grantex.dev`.
