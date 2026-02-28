# Grantex Go SDK

Official Go SDK for the [Grantex](https://grantex.dev) delegated authorization protocol — OAuth 2.0 for AI agents.

## Installation

```bash
go get github.com/mishrasanjeev/grantex-go
```

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
| `client.SSO` | CreateConfig, GetConfig, DeleteConfig, GetLoginURL, HandleCallback |
| `client.PrincipalSessions` | Create |

## Standalone Functions

```go
// Offline JWT verification
grant, err := grantex.VerifyGrantToken(ctx, token, grantex.VerifyOptions{
    JwksURI:        "https://api.grantex.dev/.well-known/jwks.json",
    RequiredScopes: []string{"read:email"},
})

// PKCE challenge generation
pkce, err := grantex.GeneratePKCE()

// Webhook signature verification
valid := grantex.VerifyWebhookSignature(payload, signature, secret)

// Developer signup (no API key needed)
resp, err := grantex.Signup(ctx, grantex.SignupParams{Name: "My App"})
```

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

Full documentation at [grantex.dev/docs](https://grantex.dev/docs).

## License

Apache 2.0
