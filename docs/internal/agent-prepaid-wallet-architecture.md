# Agent Prepaid Wallet Architecture

Status: implementation design

## Security boundary

Grantex is the authorization, policy, reservation, and audit authority. It does
not claim that a database row is an on-chain or regulated custodial account.
Sandbox wallets use the built-in ledger. Live wallets reference an external
custody provider and may be credited only with a provider reference.

Agent runtimes never receive custody credentials from Grantex. They receive a
short-lived, one-time payment authorization bound to the agent, principal,
wallet, amount, asset, network, recipient, resource, scope, and reservation.

## Actors

- Principal: owns the prepaid funds and controls assignment, policy, reload,
  blocking, and release decisions through a principal-session token.
- Agent: holds a DPoP-bound OAuth access token and can inspect assigned wallets,
  reserve an allowed payment, and request a reload.
- Resource server: presents x402 v2 payment requirements and sends the signed
  payment payload to the Grantex facilitator for verification and settlement.
- Grantex wallet authority: serializes policy checks and balance changes in
  PostgreSQL and signs wallet authorization JWTs.
- Custody adapter: confirms or executes real-world funding and settlement for
  live wallets. No live adapter means live settlement fails closed.

## Data model

`prepaid_wallets` stores one asset on one CAIP-2 network. Balances are integer
atomic units using `NUMERIC(78,0)`; floating point values are never accepted.

`agent_wallet_assignments` is a many-to-many agent/wallet relationship. Each
assignment carries a per-transaction cap, rolling cumulative cap, period,
recipient allowlist, scope allowlist, validity interval, and status.

`agent_wallet_controls` provides an independent principal-controlled kill
switch for every wallet assigned to an agent.

`wallet_payment_reservations` is the durable replay and concurrency boundary.
Creation locks the wallet and assignment, releases expired reservations,
checks all policy, moves funds from available to reserved, and records a unique
idempotency key and canonical request hash in one transaction.

`wallet_ledger_entries` is append-only evidence for credits, settlements, and
releases. `wallet_reload_requests` separates an agent's request, the principal's
decision, and confirmation that funds were actually credited.

## Payment lifecycle

1. An x402 resource returns a v2 `PAYMENT-REQUIRED` declaration.
2. The agent scheme asks the wallet authority to authorize the exact selected
   requirement using a DPoP-bound OAuth token.
3. The authority selects an eligible assigned wallet or validates the requested
   wallet, atomically reserves funds, and returns a short-lived signed JWT.
4. The agent sends a standard v2 `PAYMENT-SIGNATURE` payload containing that
   authorization.
5. The facilitator verifies JWT signature, request binding, expiry, active
   reservation state, assignment state, wallet state, the originating OAuth
   grant/token, and both wallet kill switches.
6. After the protected handler succeeds, facilitator settlement atomically
   consumes the reservation and records one ledger debit. Repeated settlement
   returns the original transaction instead of charging again.
   A settled authorization no longer passes verification, preventing the
   protected handler from being executed again by replay.
7. An un-settled authorization expires. The periodic sweep or next serialized wallet operation
   releases its reservation; an expired authorization can no longer settle.

## Reload lifecycle

The agent may create one pending reload request when available balance is at or
below the configured threshold. The principal may approve or reject it.
Approval does not change the wallet balance. A separate funding action records
the external provider reference and credits the wallet. Sandbox-ledger wallets
may use a generated sandbox reference; external wallets require an explicit
provider reference.

## Blocking semantics

- Blocking one assignment prevents that agent from using that wallet.
- Blocking a wallet prevents every assigned agent from using it.
- Blocking all wallets for an agent prevents every assignment, including future
  reservations, without suspending the agent's unrelated permissions.
- Every block operation releases still-pending reservations atomically.
- Existing settled payments are immutable and are never reversed by a block.

## Failure rules

- Database, replay-store, signature, or policy uncertainty fails closed.
- Agent callers cannot settle or release reservations.
- A reload approval cannot credit funds.
- Duplicate idempotency keys with different request bodies are rejected.
- Amounts, asset, network, recipient, and resource are compared exactly at
  verification and settlement.
- Financial-ledger and balance updates are committed in the same database transaction.

## Required production adapter

The built-in `sandbox_ledger` mode provides deterministic local and CI testing.
Production must configure an external custody/facilitator adapter that confirms
funding and settlement. Until that adapter is configured, a wallet in
`external` custody mode may be assigned and inspected but cannot be funded or
settled through an unverified local assertion.
