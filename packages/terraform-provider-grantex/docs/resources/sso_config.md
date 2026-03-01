# grantex_sso_config (Resource)

Manages a Grantex SSO configuration. Configures single sign-on for your organization using an external identity provider (Okta, Azure AD, or Google).

Only one SSO configuration can exist per organization. Creating a new configuration replaces the existing one.

## Example Usage

```hcl
resource "grantex_sso_config" "okta" {
  provider      = "okta"
  domain        = "example.com"
  client_id     = var.okta_client_id
  client_secret = var.okta_client_secret
  metadata_url  = "https://example.okta.com/.well-known/openid-configuration"
}
```

## Schema

### Required

- `provider` (String) - The SSO identity provider: `"okta"`, `"azure_ad"`, or `"google"`.
- `domain` (String) - The email domain for SSO (e.g., `"example.com"`).
- `client_id` (String) - The OAuth client ID from the identity provider.
- `client_secret` (String, Sensitive) - The OAuth client secret from the identity provider.

### Optional

- `metadata_url` (String) - The SAML/OIDC metadata URL from the identity provider.

### Read-Only

- `id` (String) - The unique identifier for the SSO configuration.
- `created_at` (String) - The timestamp when the SSO configuration was created.

## Import

SSO configurations can be imported:

```shell
terraform import grantex_sso_config.okta <sso_config_id>
```
