# grantex_sso_config (Resource)

Manages your organisation's OIDC single sign-on configuration (`POST`/`GET`/`DELETE /v1/sso/config`).

Only one SSO configuration exists per organisation. Creating this resource replaces any existing configuration, and updating it re-submits the full configuration.

## Example Usage

```hcl
resource "grantex_sso_config" "okta" {
  issuer_url    = "https://example.okta.com"
  client_id     = var.okta_client_id
  client_secret = var.okta_client_secret
  redirect_uri  = "https://app.example.com/sso/callback"
}
```

## Schema

### Required

- `issuer_url` (String) - The OIDC issuer URL of the identity provider (e.g., `"https://example.okta.com"`).
- `client_id` (String) - The OAuth client ID from the identity provider.
- `client_secret` (String, Sensitive) - The OAuth client secret from the identity provider. The API never returns it; the configured value is kept in state.
- `redirect_uri` (String) - The redirect URI registered with the identity provider for the SSO callback.

### Read-Only

- `id` (String) - Always `default`; the API holds a single SSO configuration per organisation.
- `created_at` (String) - The timestamp when the SSO configuration was created.
- `updated_at` (String) - The timestamp when the SSO configuration was last updated.

## Import

The organisation's SSO configuration can be imported. Any import ID is accepted and normalised to `default`:

```shell
terraform import grantex_sso_config.okta default
```

`client_secret` cannot be read back from the API, so the first plan after import will re-submit the configuration with the secret from your configuration.

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
