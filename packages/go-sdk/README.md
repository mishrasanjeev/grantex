# Grantex Go SDK

Official Go SDK for the [Grantex](https://grantex.dev) delegated authorization protocol — OAuth 2.0 for AI agents.

## Installation

```bash
go get github.com/mishrasanjeev/grantex-go
```

Requires Go 1.26.1 or newer, matching the module's `go.mod` directive.

## Quick Start

```go
package main

import (
    "context"
    "fmt"
    "log"

    grantex "github.com/mishrasanjeev/grantex-go"
)

func main() {
    ctx := context.Background()
    client := grantex.NewClient("your-api-key")

    // Register an agent
    agent, err := client.Agents.Register(ctx, grantex.RegisterAgentParams{
        Name:        "Email Assistant",
        Description: "Reads and sends emails on behalf of users",
        Scopes:      []string{"read:email", "send:email"},
    })
    if err != nil {
        log.Fatal(err)
    }

    // Create authorization request
    authReq, err := client.Authorize(ctx, grantex.AuthorizeParams{
        AgentID:     agent.ID,
        PrincipalID: "user-123",
        Scopes:      []string{"read:email", "send:email"},
        Audience:    "https://mail-api.example.com",
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Send user to: %s\n", authReq.ConsentURL)

    // Exchange code for token (after user consents)
    tokenResp, err := client.Tokens.Exchange(ctx, grantex.ExchangeTokenParams{
        Code:    "authorization-code",
        AgentID: agent.ID,
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Grant token: %s\n", tokenResp.GrantToken)
}
```

## Configuration

```go
client := grantex.NewClient("api-key",
    grantex.WithBaseURL("https://your-instance.example.com"),
    grantex.WithTimeout(60 * time.Second),
    grantex.WithHTTPClient(customClient),
)
```

## Available Resources

| Service | Methods |
|---------|---------|
| `client.Agents` | Register, Get, List, Update, Delete |
| `client.Tokens` | Exchange, Refresh, Verify, Revoke |
| `client.Grants` | Get, List, Revoke, Delegate |
| `client.Audit` | Log, List, Get |
| `client.Webhooks` | Create, List, Delete |
| `client.Billing` | GetSubscription, CreateCheckout, CreatePortal |
| `client.Policies` | Create, List, Get, Update, Delete |
| `client.Compliance` | GetSummary, ExportGrants, ExportAudit, EvidencePack |
| `client.Anomalies` | Detect, List, Acknowledge |
| `client.SCIM` | CreateToken, ListTokens, RevokeToken, ListUsers, GetUser, CreateUser, ReplaceUser, UpdateUser, DeleteUser |
| `client.SSO` | Enterprise connections, enforcement, sessions, login, OIDC/SAML/LDAP callbacks, and legacy config methods |
| `client.PrincipalSessions` | Create |
| `client.Budgets` | Allocate, Debit, Balance, Allocations, Transactions |
| `client.Events` | Stream |
| `client.Usage` | Current, History |
| `client.Domains` | Create, List, Verify, Delete |
| `client.WebAuthn` | RegisterOptions, RegisterVerify, ListCredentials, DeleteCredential |
| `client.Credentials` | Get, List, Verify, Present |
| `client.Passports` | Issue, Get, List, Revoke |
| `client.Vault` | Store, List, Get, Delete, Exchange |
| `client.DPDP` | Consent records/notices, grievances, erasure, principal records, exports |
| `client.Commerce` | GetProfile, SearchCatalog, CreateCart, CreatePaymentIntent, CreateCheckoutLink, GetOpsHealth |

## Commerce V1 / OACP

```go
profile, err := client.Commerce.GetProfile(ctx, "mch_shopify_mgx0n6_22")
products, err := client.Commerce.SearchCatalog(ctx, grantex.CommerceRecord{
    "merchant_id": "mch_shopify_mgx0n6_22",
    "limit":       3,
})
```

## Standalone Functions

```go
// Local JWT verification using remotely retrieved JWKS
grant, err := grantex.VerifyGrantToken(ctx, token, grantex.VerifyOptions{
    JwksURI:        "https://api.grantex.dev/.well-known/jwks.json",
    RequiredScopes: []string{"read:email"},
    Audience:       "https://api.example.com",
})

// PKCE challenge generation
pkce, err := grantex.GeneratePKCE()

// Webhook signature verification
valid := grantex.VerifyWebhookSignature(payload, signature, secret)

// Developer signup (no API key needed)
resp, err := grantex.Signup(ctx, grantex.SignupParams{Name: "My App"})
```

`VerifyGrantToken` always validates the RS256 signature, expiry, issuer, and the
required Grantex claims (`jti`, `sub`, `agt`, `dev`, `scp`, `iat`, and `exp`).
The hosted JWKS URL is automatically mapped to the canonical
`https://grantex.dev` issuer. For custom deployments, set `Issuer` explicitly or
set `IssuerDID` to a `did:web` identifier; otherwise the issuer is derived from
`JwksURI`. `Audience` and `RequiredScopes` add application-specific checks.

## Error Handling

```go
agent, err := client.Agents.Get(ctx, "id")
if err != nil {
    switch e := err.(type) {
    case *grantex.AuthError:
        // 401/403
    case *grantex.APIError:
        // Other HTTP errors
    case *grantex.NetworkError:
        // Connection/timeout
    case *grantex.TokenError:
        // JWT verification errors
    }
}
```

## Documentation

Full documentation at [docs.grantex.dev](https://docs.grantex.dev).

## License

Apache 2.0
