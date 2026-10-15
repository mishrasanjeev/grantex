# Website enquiry delivery

The website contact form uses the shared AgenticOrg marketing delivery service,
not a separate form vendor. It posts bounded JSON to
`https://app.agenticorg.ai/api/v1/demo-request` with `product=grantex`.

The operator configures the authenticated SMTP mailbox and marketing notification
destination on the backend. Requester confirmations still go to the requester.
The Grantex message is encrypted in the durable outbox and HTML-escaped in mail;
contact details and message content are never analytics event fields. Grantex
enquiries do not start an AI sales-agent action or change model budgets.

## Release and acceptance

1. Release the backend with both durable delivery and Grantex enquiries enabled.
   Grantex support defaults off through `AGENTICORG_GRANTEX_ENQUIRIES_ENABLED`.
2. Verify the backend permits uncredentialed POST/preflight only on the public
   enquiry path for the exact website origins. Do not widen tenant API CORS.
3. Test the website with a local API, worker, Postgres, Redis and SMTP capture.
   Check distinct notification/requester recipients, encrypted storage, worker
   recovery, replay without duplicate mail, validation and failure input retention.
4. Publish the website only after the backend is available. Submit one labelled
   owner-only enquiry and verify both persisted SMTP outcomes and actual inbox
   arrival. Exclude synthetic tests from prospect/conversion reporting.

The form's accepted message proves persisted intake, not inbox arrival. It clears
only after a durable receipt; provider rejection, malformed responses and timeout
retain the enquiry and offer direct email. Existing pending-submit protection
prevents duplicate concurrent requests. Ambiguous SMTP outcomes require operator
review, not automatic resending or replaying historical prospects.

The website sends no login cookies to this intake. This shared marketing service
does not route authorization requests, agent conversations or commerce payments.
If unavailable, use the published direct-email contact. Do not restore an
unverified third-party form as an automatic fallback.
