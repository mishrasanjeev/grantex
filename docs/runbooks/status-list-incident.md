# Runbook: issuer status list incidents

For registry operators running the auth service with
`REGISTRY_STATUS_RECONCILIATION_ENABLED=true`. How reconciliation works is in
`spec/registry-federation.md`, "Status reconciliation"; the alerts are in
`deploy/prometheus/registry-status-alerts.yml`.

Two incidents are covered: an accredited issuer's status list cannot be read,
and an issuer's list flips many passports at once.

## What the registry does on its own

- A list it cannot read changes nothing. Every attestation on it keeps its
  recorded status until the registry's last good read runs out (the list's
  `ttl`, its `exp`, or a day, whichever is first). From then on those
  attestations stop counting toward trust levels, and every grant bound to one
  of their passports refuses to refresh (and pending authorizations refuse the
  code exchange) with `status_stale`. Nothing is revoked because a list is
  unreadable, and nothing is treated as valid either.
- The registry tries the list again after `REGISTRY_STATUS_POLL_MIN_INTERVAL_MS`,
  and keeps trying. The first good read restores everything: statuses fresh
  again, trust levels counted, refreshes allowed.
- A list that shows a passport revoked revokes every grant bound to it, with
  its delegated grants; one that shows it suspended suspends them; a
  reinstatement resumes what the registry suspended. Revocation cannot be
  undone.
- The lists of a suspended or withdrawn issuer are not read, so nothing on
  them is acted on. Its attestations' acceptance and every grant bound to
  their passports are suspended instead. When the issuer is reinstated, an
  attestation returns to VALID, and its grants resume, only once its list has
  been read again and still shows the passport valid: the registry does not
  rely on a read older than the list's `ttl`. A reinstated issuer's lists are
  read at the next tick; if one is still unreadable, what is on it stays
  suspended.

## An issuer list is unreadable

Alert: `GrantexRegistryStatusPollFailures` first, then
`GrantexRegistryStatusListStale` once the last good read has run out.

1. Find the issuer. The auth service logs a warning for each failed poll with
   `worker=registry-status-reconciliation`, the `issuerId` and the `reason`.
   The metric `grantex_registry_status_list_poll_failures_total` carries the
   reason only.
2. Read the reason:

   | Reason | Usually |
   |---|---|
   | `unreachable` | DNS, TLS, a timeout (5 s) or a refused connection at the issuer. |
   | `http_status` | The issuer answered something other than `200`, including a redirect, which the registry never follows. |
   | `content_type` | The list is not served as `application/statuslist+jwt`. |
   | `too_large` | The list is larger than 1 MiB. |
   | `invalid` | The token did not verify with the issuer's recorded keys, its `sub` is not the list URI, it has expired, or it has no entry at an attestation's index. |
   | `not_under_base` | The list URI is not under the issuer's `status_list_base`. |
   | `issuer_unknown` | The issuer record is gone. |
   | `issuer_changed` | The issuer was suspended or withdrawn, or the key the list was signed with was revoked, while the list was being fetched. The read was discarded; expected right after such a `PATCH`, and nothing to do. |
   | `dev_map_refused` | `REGISTRY_DEV_ISSUER_ORIGIN_MAP` is set outside development and tests. Unset it. |
   | `error` | The registry's own database failed while recording. Check the database first. |

3. Contact the issuer through the channel recorded with its accreditation.
   Ask whether its list host is down, whether it rotated a signing key without
   telling the registry (`invalid`), or whether it moved its lists
   (`http_status` for a redirect).
4. If the issuer rotated its key, have it send the new public key and replace
   the JWK Set with `PATCH /v1/registry/issuers/{id}` (`jwks`), keeping the old
   key until every attestation it signed has been replaced. Do not revoke the
   old kid for a routine rotation: revoking a kid withdraws every attestation it
   signed and revokes the grants bound to them.
5. If the issuer cannot restore its list soon and you no longer want its
   passports relied on, suspend it (`PATCH /v1/registry/issuers/{id}`,
   `status: suspended`, with a reason). That suspends its attestations'
   acceptance and every bound grant, and stops the registry reading its
   lists. A reinstatement later resumes them once each list reads again and
   still shows the passport valid; anything the issuer revoked in the
   meantime is revoked then.
   Suspension is the reversible choice; withdrawal (`status: withdrawn`) is
   treated the same way by reconciliation but tells relying parties the issuer
   is no longer accredited.
6. Once the list reads again, `grantex_registry_status_lists_stale` returns to
   0 within one tick and the alerts clear. Nothing else needs to be done.

Do not work around an unreadable list by editing `registry_attestations` or
the acceptance entries by hand: the registry would then stand behind statuses no
one has read.

## Many passports flip at once

Alert: `GrantexRegistryStatusMassFlip`, and a jump in
`grantex_registry_cascade_grants_total{action="revoked"}` or
`{action="suspended"}`.

1. Find the issuer in the audit chain: the registry chain carries
   `grantex.registry.attestation_issuer_status_changed` and
   `grantex.registry.attestation_acceptance_changed` entries with the issuer's
   entity id.
2. Ask the issuer whether it meant it. A deliberate mass revocation (a breach
   at the issuer, a compromised batch) needs nothing more from the registry:
   the grants are already revoked and the revocation feed has told relying
   parties.
3. If the issuer published a wrong list, suspend the issuer at once
   (`PATCH /v1/registry/issuers/{id}`, `status: suspended`). The registry
   stops reading its lists, so no further flip is acted on while it is fixed,
   and it suspends every bound grant of the issuer's passports in the
   meantime. A read of its list already in flight when the suspension
   commits is discarded, not recorded (`issuer_changed`). Flips the registry
   recorded before the suspension stay recorded.
   Reinstate the issuer only once it publishes the right list: the first read
   after the reinstatement decides, and entries it shows valid come back.
   Entries the wrong list showed as suspended come back the same way.
   Entries it showed as revoked cannot: INVALID is final on the issuer's list
   (draft-ietf-oauth-status-list-21 §7.1) and in the registry, and revoked
   grants stay revoked. The issuer issues new passports and posts new
   attestations; agents ask for new grants.
4. Tell the developers whose grants were revoked. Their `grant.revoked`
   webhooks carry `cause: registry` and the reason.

## Turning reconciliation on

`REGISTRY_STATUS_RECONCILIATION_ENABLED=true` needs `DATABASE_POOL_MAX` of at
least 2 (the default is 3): a run holds one connection for its advisory lock
and works through another. With a pool of 1 the service refuses to start and
names both variables.

Kids revoked while reconciliation was off are acted on once it runs: the
loop withdraws every accepted attestation signed with a revoked kid, however
long ago it was revoked, and revokes the grants bound to them. With many
accepted attestations this takes a few ticks (at most 2000 attestations are
checked a run); `grantex_registry_acceptance_changes_total{cause="key_revoked"}`
counts them.

## Turning reconciliation off

Setting `REGISTRY_STATUS_RECONCILIATION_ENABLED` to anything but `true` and
restarting stops the loop and the cascade on `PATCH`; the per-attestation
recheck worker takes over keeping recorded statuses fresh. Grants already
revoked stay revoked, and grants the registry suspended stay suspended until
reconciliation is turned on again and their passports read valid.
