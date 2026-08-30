# Candidate DAAP Extensions

The `draft-mishra-oauth-agent-grants-03` working candidate deliberately keeps
these subjects outside its interoperable OAuth core. This directory records
possible follow-on work; none of these items is an Internet-Draft, an IETF
submission, or a Working Group commitment.

## Audit Checkpoints

Define canonical audit records, signed chain-head checkpoints, and external
witness protocols. The security model must distinguish tamper evidence from
operator independence and should use RFC 8785 canonical JSON and an established
transparency or timestamping mechanism.

## Financial Authorization Details

Define Rich Authorization Requests for amount, currency, merchant, purpose,
and transaction limits. Token hints must not replace atomic authorization and
settlement at the protected resource.

## Delegation Lifecycle

Profile RFC 8693 actor chains, depth limits, descendant discovery, and cascade
revocation without inventing duplicate JWT claims.

## Operational Interfaces

Evaluate whether event delivery, policy decision points, anomaly signals, and
credential exchange need interoperable protocols. Each has a different trust
boundary and should not be bundled merely because one product implements all
of them.

## Promotion Gate

Before any topic becomes a separate draft:

1. document at least two independent implementation use cases;
2. identify overlap with active IETF and OpenID work;
3. define a narrow threat model and privacy model;
4. avoid vendor-specific endpoint paths and identifiers; and
5. ask the relevant Working Group whether the problem is in scope.
