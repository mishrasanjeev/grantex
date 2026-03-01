terraform {
  required_providers {
    grantex = {
      source  = "mishrasanjeev/grantex"
      version = "~> 0.1"
    }
  }
}

# Configure the Grantex provider.
# The API key can also be set via the GRANTEX_API_KEY environment variable.
provider "grantex" {
  api_key  = var.grantex_api_key
  base_url = "https://api.grantex.dev"
}

variable "grantex_api_key" {
  type        = string
  sensitive   = true
  description = "API key for the Grantex API"
}

variable "webhook_secret" {
  type        = string
  sensitive   = true
  description = "Secret for signing webhook payloads"
}

variable "okta_client_id" {
  type        = string
  description = "Okta OAuth client ID"
}

variable "okta_client_secret" {
  type        = string
  sensitive   = true
  description = "Okta OAuth client secret"
}

# --- Resources ---

# Create an AI agent for calendar management
resource "grantex_agent" "calendar_bot" {
  name        = "Calendar Bot"
  description = "Manages calendar events on behalf of users"
  scopes      = ["calendar:read", "calendar:write", "calendar:delete"]
}

# Create an AI agent for email triage
resource "grantex_agent" "email_triager" {
  name        = "Email Triager"
  description = "Reads and categorizes emails"
  scopes      = ["email:read"]
}

# Policy: Allow read access for all agents
resource "grantex_policy" "allow_read" {
  name   = "Allow Read Access"
  effect = "allow"
  scopes = ["calendar:read", "email:read"]
}

# Policy: Deny calendar writes outside business hours
resource "grantex_policy" "deny_after_hours" {
  name              = "Deny After-Hours Calendar Writes"
  effect            = "deny"
  priority          = 10
  agent_id          = grantex_agent.calendar_bot.agent_id
  scopes            = ["calendar:write", "calendar:delete"]
  time_of_day_start = "00:00"
  time_of_day_end   = "08:00"
}

# Webhook for grant lifecycle events
resource "grantex_webhook" "grant_events" {
  url    = "https://example.com/webhooks/grantex"
  events = ["grant.created", "grant.revoked", "grant.expired", "token.used"]
  secret = var.webhook_secret
}

# SSO configuration with Okta
resource "grantex_sso_config" "okta" {
  provider      = "okta"
  domain        = "example.com"
  client_id     = var.okta_client_id
  client_secret = var.okta_client_secret
  metadata_url  = "https://example.okta.com/.well-known/openid-configuration"
}

# Budget allocation for the calendar bot
resource "grantex_budget_allocation" "calendar_bot_budget" {
  grant_id       = "grant_placeholder_id"
  initial_budget = 50.00
  currency       = "USD"
}

# --- Data Sources ---

# Look up an existing agent
data "grantex_agent" "existing_agent" {
  agent_id = grantex_agent.calendar_bot.agent_id
}

# List all active grants for the calendar bot
data "grantex_grants" "calendar_bot_grants" {
  agent_id = grantex_agent.calendar_bot.agent_id
  status   = "active"
}

# --- Outputs ---

output "calendar_bot_id" {
  value       = grantex_agent.calendar_bot.agent_id
  description = "The agent ID for the calendar bot"
}

output "calendar_bot_did" {
  value       = grantex_agent.calendar_bot.did
  description = "The DID for the calendar bot"
}

output "email_triager_id" {
  value       = grantex_agent.email_triager.agent_id
  description = "The agent ID for the email triager"
}

output "active_grants_count" {
  value       = length(data.grantex_grants.calendar_bot_grants.grants)
  description = "Number of active grants for the calendar bot"
}

output "webhook_id" {
  value       = grantex_webhook.grant_events.id
  description = "The webhook ID for grant events"
}
