# Grantex: Tool Manifest, Scope Enforcer & SDK Integration

## Vision

A developer using Cursor, Claude Code, Copilot, or Codex says:

> "Add Grantex scope enforcement to my AI agent's tool calls"

And the AI coding tool does it end-to-end — no manual API calls, no reading docs, no separate package installs. Everything ships inside the existing SDKs.

---

## Real-World Case Study: AgenticOrg

[AgenticOrg](https://github.com/mishrasanjeev/agentic-org) is an enterprise AI agent orchestration platform — 35 agents across 6 domains, connected to **54 enterprise systems via 340+ tools**. It's live at [agenticorg.ai](https://agenticorg.ai).

### The Problem AgenticOrg Faced

AgenticOrg agents call real APIs — Salesforce, Jira, HubSpot, SAP, S3, Gmail, Stripe, and 47 more. Each agent has a shared service account credential for each system. The challenge:

- **Agent A** (AP Processor) should only read invoices, not delete contacts
- **Agent B** (Sales Rep) should create leads, not approve payments
- **Agent C** (Recruiter) should post jobs, not terminate employees
- All 35 agents share the same Salesforce OAuth token — the credential itself doesn't restrict them

### How AgenticOrg Solved It With Grantex

```
┌──────────────┐     Grantex Token      ┌─────────────────────┐    Shared Creds    ┌────────────┐
│   AI Agent    │ ─────────────���─────→   │    Tool Gateway      │ ────────────────→  │  Salesforce │
│ (no creds)   │                        │ verify token → check │                    │  S3, Jira   │
│              │ ←── scoped response ── │ scope → connector    │ ←── response ───── │  SAP, FTP   │
└──────────────┘                        └─────────────────────┘                    └────────────┘
                                              ↓ audit
                                         Grantex Cloud
```

1. **Agent creation** → auto-registers on Grantex, gets a DID, tools mapped to scopes
2. **Human approves** → Grantex issues RS256 signed grant token with specific scopes
3. **Every tool call** → Tool Gateway verifies token, checks scopes, then calls the connector
4. **Agent never sees** the Salesforce/S3/Jira credentials — only the Grantex token
5. **Revoke a grant** → agent immediately loses access across ALL connected systems

### The Remaining Gap

AgenticOrg's Tool Gateway guesses `read` vs `write` from tool name keywords:

```python
# Fragile — "process_refund" passes as "read" because no keyword matches
permission = "write" if any(w in tool_name for w in ("create", "delete", ...)) else "read"
```

**Grantex should ship the solution**: standard tool manifests with explicit permission declarations, so no platform has to guess.

---

## Design Principles

1. **Zero new packages to install** — enforcer + manifest format ship inside `@grantex/sdk` (TS) and `grantex` (Python)
2. **One-line enforcement** — `grantex.enforce(grantToken, connector, tool)` on the existing client
3. **Pre-built manifests for 54 connectors** matching AgenticOrg's production inventory, bundled in SDK
4. **Custom manifests for anything else** — inline definition, JSON/YAML file, or CLI auto-generation from code
5. **CLI-first manifest workflow** — `grantex manifest generate ./connectors/` auto-generates from code
6. **LLM-readable docs** — every API and pattern in `llms.txt` / Mintlify docs so AI coding tools can implement autonomously

---

## Custom Connectors & Tools — How Consumer Apps Extend

Grantex ships 54 pre-built manifests, but enterprises will always have:

- **Internal APIs** — `inventory-service`, `pricing-engine`, `loan-underwriter`
- **Connectors Grantex hasn't mapped** — Snowflake, Databricks, Workday, SAP SuccessFactors
- **Extended tools on existing connectors** — `bulk_delete_all` added to Salesforce

All three are first-class. The consumer defines a custom manifest — no PRs to Grantex, no waiting for a release.

### Option 1: Inline Definition (fastest, for small connectors)

```python
from grantex import Grantex, ToolManifest, Permission

grantex = Grantex(api_key=os.environ["GRANTEX_API_KEY"])

# Your internal API — 3 lines
grantex.load_manifest(ToolManifest(
    connector="inventory-service",
    description="Internal warehouse inventory API",
    tools={
        "get_stock_level":      Permission.READ,
        "reserve_inventory":    Permission.WRITE,
        "release_reservation":  Permission.WRITE,
        "adjust_stock":         Permission.WRITE,
        "force_stock_reset":    Permission.ADMIN,
    },
))

# Enforcement works identically to pre-built manifests
result = grantex.enforce(
    grant_token=token,
    connector="inventory-service",
    tool="force_stock_reset",
)
# ❌ DENIED if agent only has write scope
```

```typescript
import { Grantex, ToolManifest, Permission } from '@grantex/sdk';

const grantex = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });

grantex.loadManifest(new ToolManifest({
  connector: 'inventory-service',
  description: 'Internal warehouse inventory API',
  tools: {
    'get_stock_level':    Permission.READ,
    'reserve_inventory':  Permission.WRITE,
    'release_reservation': Permission.WRITE,
    'adjust_stock':       Permission.WRITE,
    'force_stock_reset':  Permission.ADMIN,
  },
}));
```

### Option 2: JSON/YAML File (for teams, committed to git)

```json
{
  "connector": "inventory-service",
  "version": "1.0.0",
  "description": "Internal warehouse inventory API",
  "tools": {
    "get_stock_level": "read",
    "reserve_inventory": "write",
    "release_reservation": "write",
    "adjust_stock": "write",
    "force_stock_reset": "admin"
  }
}
```

```python
# Load from file
grantex.load_manifest(ToolManifest.from_file("./manifests/inventory-service.json"))
```

```bash
# Or load via CLI
grantex manifest load ./manifests/inventory-service.json
```

### Option 3: CLI Auto-Generate (for large connector codebases)

```bash
# Scan your connector code — works with any framework
grantex manifest generate ./connectors/inventory_service.py
# → Scanned 5 tools, inferred permissions:
#   get_stock_level      → read   (contains "get")
#   reserve_inventory    → write  (contains no read keyword)
#   release_reservation  → write
#   adjust_stock         → write
#   force_stock_reset    → admin  (contains "force"/"reset")
# → Saved to ./manifests/inventory-service.json
# → Review and commit to git

# Scan an entire directory
grantex manifest generate ./connectors/ --recursive
# → Generated 12 custom manifests (68 tools)
```

The generator uses heuristics to infer permissions:
- `get_`, `list_`, `search_`, `query_`, `fetch_`, `check_`, `download_` → **read**
- `create_`, `update_`, `send_`, `post_`, `upload_`, `apply_`, `file_`, `record_` → **write**
- `delete_`, `remove_`, `void_`, `terminate_`, `revoke_`, `cancel_` → **delete**
- `run_`, `force_`, `reset_`, `drop_`, `purge_` → **admin**
- Anything ambiguous → **read** (safe default) with a ⚠ warning to review

The developer reviews the output, corrects any wrong inferences, and commits the file.

### Option 4: Extend a Pre-Built Manifest

Enterprise added `bulk_delete_all` to their Salesforce connector:

```python
from grantex.manifests.salesforce import manifest as sf_manifest

# Extend the pre-built manifest with custom tools
sf_manifest.add_tool("bulk_delete_all", Permission.ADMIN)
sf_manifest.add_tool("export_all_contacts", Permission.READ)
sf_manifest.add_tool("import_csv", Permission.WRITE)

grantex.load_manifest(sf_manifest)
```

```typescript
import { salesforceManifest } from '@grantex/sdk/manifests/salesforce';

salesforceManifest.addTool('bulk_delete_all', Permission.ADMIN);
salesforceManifest.addTool('export_all_contacts', Permission.READ);

grantex.loadManifest(salesforceManifest);
```

### Option 5: Load All Manifests from a Directory

```python
# Load all JSON manifests from a directory — pre-built + custom
grantex.load_manifests_from_dir("./manifests/")
```

```bash
# Directory structure:
manifests/
  salesforce.json         ← pre-built (copied from SDK or generated)
  hubspot.json            ← pre-built
  inventory-service.json  ← custom internal API
  pricing-engine.json     ← custom internal API
  snowflake.json          ← custom (Grantex doesn't ship this yet)
```

### What Happens When a Tool Has No Manifest?

If `grantex.enforce()` is called with a connector/tool that has no manifest loaded:

```python
result = grantex.enforce(
    grant_token=token,
    connector="unknown-service",
    tool="do_something",
)
# result.allowed = False
# result.reason = "No manifest loaded for connector 'unknown-service'. Load a manifest first."
```

**Fail closed** — unknown tools are denied by default. The developer must explicitly declare permissions for every tool. This is the safe behavior.

Configurable for development/testing:

```python
grantex = Grantex(
    api_key=key,
    enforce_mode="strict",     # default — deny unknown tools
    # enforce_mode="permissive",  # dev only — allow unknown tools with warning
)
```

### Community Manifest Registry (Future)

Once the manifest format is stable, open a community registry where anyone can contribute manifests for connectors Grantex doesn't ship:

```bash
# Browse community manifests
grantex manifest search snowflake
# → snowflake (community) — 12 tools — by @data-eng-team
# → snowflake-extended (community) — 18 tools — by @acme-corp

# Install a community manifest
grantex manifest install snowflake
# → Downloaded to ./manifests/snowflake.json
```

This is a future enhancement — not needed for the initial release.

---

## SDK Changes

### TypeScript SDK (`@grantex/sdk`)

```typescript
import { Grantex } from '@grantex/sdk';
import { salesforceManifest } from '@grantex/sdk/manifests/salesforce';
import { hubspotManifest } from '@grantex/sdk/manifests/hubspot';

const grantex = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });
grantex.loadManifests([salesforceManifest, hubspotManifest]);

// Before any tool call — one line:
const result = grantex.enforce({
  grantToken: agentToken,
  connector: 'salesforce',
  tool: 'delete_contact',
});

if (!result.allowed) {
  throw new Error(result.reason);
  // "write scope does not cover delete operations on salesforce"
}
```

#### LangChain/LangGraph Integration

```typescript
// Wrap a LangChain tool — enforcement happens automatically before every call
const protectedTool = grantex.wrapTool(myLangChainTool, {
  connector: 'salesforce',
  tool: 'create_lead',
  grantToken: () => currentState.grant_token,
});
```

#### Express Middleware

```typescript
app.use('/api/tools/*', grantex.enforceMiddleware({
  extractToken: (req) => req.headers.authorization?.replace('Bearer ', ''),
  extractConnector: (req) => req.params.connector,
  extractTool: (req) => req.params.tool,
}));
```

### Python SDK (`grantex`)

```python
from grantex import Grantex
from grantex.manifests.salesforce import manifest as sf
from grantex.manifests.hubspot import manifest as hs

grantex = Grantex(api_key=os.environ["GRANTEX_API_KEY"])
grantex.load_manifests([sf, hs])

# Before any tool call — one line:
result = grantex.enforce(
    grant_token=agent_token,
    connector="salesforce",
    tool="delete_contact",
)
if not result.allowed:
    raise PermissionError(result.reason)
```

#### LangChain Wrapper

```python
protected_tool = grantex.wrap_tool(
    my_langchain_tool,
    connector="salesforce",
    tool="create_lead",
    grant_token=lambda: current_state["grant_token"],
)
```

#### FastAPI Dependency

```python
from grantex.fastapi import GrantexEnforcer

enforcer = GrantexEnforcer(grantex)

@app.post("/api/tools/{connector}/{tool}")
async def execute_tool(connector: str, tool: str, auth: EnforceResult = Depends(enforcer)):
    ...  # auth.allowed is guaranteed True here
```

---

## Full API Reference

### `Grantex` Client — New Methods

```python
class Grantex:
    # Existing methods remain unchanged...

    def load_manifest(self, manifest: ToolManifest) -> None
    def load_manifests(self, manifests: list[ToolManifest]) -> None

    def enforce(
        self,
        grant_token: str,
        connector: str,
        tool: str,
        amount: float | None = None,     # for capped scopes
    ) -> EnforceResult

    def wrap_tool(
        self,
        tool: StructuredTool,
        connector: str,
        tool_name: str,
        grant_token: str | Callable[[], str],  # static or dynamic
    ) -> StructuredTool
```

### `EnforceResult`

```python
class EnforceResult:
    allowed: bool          # True if tool call is permitted
    reason: str            # Human-readable reason if denied
    grant_id: str          # From JWT claims
    agent_did: str         # From JWT claims
    scopes: list[str]      # All granted scopes
    permission: str        # Resolved permission for this tool (read/write/delete)
    connector: str         # Connector name
    tool: str              # Tool name
```

### `ToolManifest`

```python
class ToolManifest:
    connector: str                 # e.g., "salesforce"
    version: str                   # e.g., "1.0.0"
    description: str               # Human-readable
    tools: dict[str, str]          # tool_name → Permission (read/write/delete/admin)

    def get_permission(self, tool_name: str) -> str
```

### `Permission` — Hierarchy

```python
class Permission:
    READ = "read"       # Level 0 — query, list, get, search, fetch, check, download
    WRITE = "write"     # Level 1 — create, update, send, post, upload, apply, file
    DELETE = "delete"    # Level 2 — delete, remove, void, terminate, revoke, cancel
    ADMIN = "admin"     # Level 3 — everything

    # Hierarchy: admin > delete > write > read
    # A "write" scope allows read + write tools, but blocks delete tools
```

| Granted Scope | Can Call READ Tools | Can Call WRITE Tools | Can Call DELETE Tools |
|:---:|:---:|:---:|:---:|
| `tool:X:read` | Yes | No | No |
| `tool:X:write` | Yes | Yes | No |
| `tool:X:delete` | Yes | Yes | Yes |
| `tool:X:admin` | Yes | Yes | Yes |

---

## Pre-Built Manifests — All 54 Connectors

Every connector from AgenticOrg's production deployment, organized by domain.

### Finance (14 connectors, 88 tools)

#### `grantex/manifests/banking_aa`
```
fetch_bank_statement   → read
check_account_balance  → read
get_transaction_list   → read
request_consent        → write
fetch_fi_data          → read
```

#### `grantex/manifests/gstn`
```
fetch_gstr2a           → read
push_gstr1_data        → write
file_gstr3b            → write
file_gstr9             → write
generate_eway_bill     → write
generate_einvoice_irn  → write
check_filing_status    → read
get_compliance_notice  → read
```

#### `grantex/manifests/netsuite`
```
create_invoice         → write
get_invoice            → read
create_journal_entry   → write
get_account_balance    → read
create_vendor_bill     → write
create_purchase_order  → write
get_trial_balance      → read
search_records         → read
```

#### `grantex/manifests/oracle_fusion`
```
post_journal_entry     → write
get_gl_balance         → read
create_ap_invoice      → write
approve_payment        → write
get_budget             → read
create_po              → write
get_trial_balance      → read
run_period_close       → admin
get_cash_position      → read
run_reconciliation     → write
```

#### `grantex/manifests/quickbooks`
```
create_invoice         → write
record_payment         → write
get_profit_loss        → read
get_balance_sheet      → read
query                  → read
get_company_info       → read
```

#### `grantex/manifests/sap`
```
post_journal_entry     → write
get_gl_balance         → read
create_purchase_order  → write
post_goods_receipt     → write
run_payment_run        → admin
get_vendor_master      → read
get_cost_center        → read
```

#### `grantex/manifests/stripe`
```
create_payment_intent  → write
list_charges           → read
create_payout          → write
get_balance            → read
list_invoices          → read
create_customer        → write
list_disputes          → read
create_refund          → write
```

#### `grantex/manifests/tally`
```
post_voucher           → write
get_ledger_balance     → read
generate_gst_report    → read
export_tally_xml_data  → read
get_trial_balance      → read
get_stock_summary      → read
```

#### `grantex/manifests/zoho_books`
```
create_invoice         → write
list_invoices          → read
record_expense         → write
get_balance_sheet      → read
get_profit_loss        → read
list_chartofaccounts   → read
reconcile_transaction  → write
```

#### `grantex/manifests/pinelabs_plural`
```
create_order           → write
check_order_status     → read
create_payment_link    → write
initiate_refund        → write
get_settlement_report  → read
get_payout_analytics   → read
```

#### `grantex/manifests/income_tax_india`
```
file_26q_return        → write
file_24q_return        → write
check_tds_credit_in_26as → read
download_form_16a      → read
file_itr               → write
get_compliance_notice  → read
pay_tax_challan        → write
```

### HR (8 connectors, 56 tools)

#### `grantex/manifests/darwinbox`
```
get_employee           → read
create_employee        → write
run_payroll            → admin
get_attendance         → read
apply_leave            → write
get_org_chart          → read
update_performance     → write
terminate_employee     → delete
transfer_employee      → write
get_payslip            → read
```

#### `grantex/manifests/docusign`
```
send_envelope          → write
get_envelope_status    → read
void_envelope          → delete
download_document      → read
list_templates         → read
create_envelope_from_template → write
```

#### `grantex/manifests/epfo`
```
file_ecr               → write
get_uan                → read
check_claim_status     → read
download_passbook      → read
generate_trrn          → write
verify_member          → read
```

#### `grantex/manifests/greenhouse`
```
list_jobs              → read
get_candidate          → read
list_applications      → read
schedule_interview     → write
create_candidate       → write
advance_application    → write
reject_application     → delete
get_scorecards         → read
```

#### `grantex/manifests/keka`
```
get_employee           → read
list_employees         → read
run_payroll            → admin
get_leave_balance      → read
post_reimbursement     → write
get_attendance_summary → read
```

#### `grantex/manifests/linkedin_talent`
```
post_job               → write
search_candidates      → read
send_inmail            → write
get_applicants         → read
get_analytics          → read
get_job_insights       → read
```

#### `grantex/manifests/okta`
```
provision_user         → write
deactivate_user        → delete
assign_group           → write
remove_group           → delete
get_access_log         → read
reset_mfa              → admin
list_active_sessions   → read
suspend_user           → delete
```

#### `grantex/manifests/zoom`
```
create_meeting         → write
get_recording          → read
cancel_meeting         → delete
get_attendance_report  → read
add_panelist           → write
get_transcript         → read
```

### Marketing (16 connectors, 107 tools)

#### `grantex/manifests/salesforce`
```
create_lead            → write
update_opportunity     → write
query                  → read
create_task            → write
get_account            → read
list_opportunities     → read
```

#### `grantex/manifests/hubspot`
```
list_contacts          → read
search_contacts        → read
create_contact         → write
get_contact            → read
update_contact         → write
list_deals             → read
create_deal            → write
get_deal               → read
update_deal            → write
list_pipelines         → read
list_companies         → read
create_company         → write
get_campaign_analytics → read
```

#### `grantex/manifests/mailchimp`
```
list_campaigns         → read
create_campaign        → write
send_campaign          → write
get_campaign_report    → read
add_list_member        → write
search_members         → read
create_template        → write
create_ab_campaign     → write
get_ab_results         → read
send_winner            → write
```

#### `grantex/manifests/google_ads`
```
search_campaigns       → read
get_campaign_performance → read
mutate_campaign_budget → write
get_search_terms       → read
create_user_list       → write
```

#### `grantex/manifests/meta_ads`
```
get_campaign_insights  → read
update_campaign_budget → write
create_custom_audience → write
update_adset_status    → write
get_ad_account_info    → read
```

#### `grantex/manifests/linkedin_ads`
```
create_campaign        → write
get_analytics          → read
create_lead_gen_form   → write
get_targeting_criteria → read
```

#### `grantex/manifests/ga4`
```
run_report             → read
run_realtime_report    → read
get_conversions        → read
get_user_acquisition   → read
get_page_analytics     → read
get_metadata           → read
```

#### `grantex/manifests/mixpanel`
```
get_funnel             → read
get_retention          → read
query_jql              → read
get_segmentation       → read
export_events          → read
```

#### `grantex/manifests/moengage`
```
create_campaign        → write
get_campaign_stats     → read
create_segment         → write
send_push_notification → write
get_user_profile       → read
track_event            → write
```

#### `grantex/manifests/ahrefs`
```
get_domain_rating      → read
get_backlinks          → read
get_organic_keywords   → read
get_content_gap        → read
get_site_audit         → read
```

#### `grantex/manifests/bombora`
```
get_surge_scores       → read
get_topic_clusters     → read
get_weekly_report      → read
search_companies       → read
```

#### `grantex/manifests/brandwatch`
```
get_mentions           → read
get_mention_summary    → read
get_share_of_voice     → read
create_alert           → write
export_report          → read
```

#### `grantex/manifests/buffer`
```
create_update          → write
get_update_analytics   → read
get_pending_updates    → read
list_profiles          → read
move_to_top            → write
```

#### `grantex/manifests/g2`
```
get_intent_signals     → read
get_product_reviews    → read
get_comparison_data    → read
get_category_leaders   → read
```

#### `grantex/manifests/trustradius`
```
get_buyer_intent       → read
get_product_reviews    → read
get_comparison_traffic → read
search_vendors         → read
```

#### `grantex/manifests/wordpress`
```
create_post            → write
update_post            → write
list_posts             → read
get_post               → read
upload_media           → write
list_categories        → read
create_page            → write
```

### Ops (7 connectors, 48 tools)

#### `grantex/manifests/jira`
```
list_projects          → read
get_project            → read
search_issues          → read
get_issue              → read
create_issue           → write
update_issue           → write
transition_issue       → write
get_transitions        → read
add_comment            → write
get_sprint_data        → read
get_project_metrics    → read
```

#### `grantex/manifests/confluence`
```
create_page            → write
update_page            → write
search_content         → read
get_page               → read
get_page_tree          → read
list_spaces            → read
```

#### `grantex/manifests/servicenow`
```
create_incident        → write
update_incident        → write
submit_change_request  → write
get_cmdb_ci            → read
check_sla_status       → read
get_kb_article         → read
```

#### `grantex/manifests/zendesk`
```
create_ticket          → write
update_ticket          → write
get_ticket             → read
apply_macro            → write
get_csat_score         → read
escalate_ticket        → write
merge_tickets          → write
get_sla_status         → read
```

#### `grantex/manifests/pagerduty`
```
create_incident        → write
acknowledge_incident   → write
resolve_incident       → write
get_on_call            → read
list_incidents         → read
create_postmortem      → write
```

#### `grantex/manifests/sanctions_api`
```
screen_entity          → read
screen_transaction     → read
get_alert              → read
batch_screen           → read
generate_report        → read
```

#### `grantex/manifests/mca_portal`
```
file_annual_return     → write
complete_director_kyc  → write
fetch_company_master_data → read
file_charge_satisfaction → write
```

### Comms (11 connectors, 67 tools)

#### `grantex/manifests/gmail`
```
send_email             → write
read_inbox             → read
search_emails          → read
get_thread             → read
```

#### `grantex/manifests/slack`
```
send_message           → write
create_channel         → write
upload_file            → write
search_messages        → read
list_channels          → read
set_reminder           → write
post_alert             → write
```

#### `grantex/manifests/github`
```
list_repos             → read
get_repo               → read
list_repository_issues → read
create_issue           → write
create_pull_request    → write
get_repository_statistics → read
search_code            → read
create_release         → write
trigger_github_action_workflow → write
```

#### `grantex/manifests/google_calendar`
```
create_event           → write
list_events            → read
check_availability     → read
delete_event           → delete
find_free_slot         → read
```

#### `grantex/manifests/s3`
```
upload_document        → write
download_document      → read
list_objects           → read
generate_signed_url    → read
delete_object          → delete
copy_object            → write
```

#### `grantex/manifests/sendgrid`
```
send_email             → write
create_template        → write
get_stats              → read
get_bounces            → read
validate_email         → read
send_email_with_tracking → write
get_email_activity     → read
```

#### `grantex/manifests/twilio`
```
send_sms               → write
make_call              → write
send_whatsapp          → write
get_recordings         → read
get_message_status     → read
```

#### `grantex/manifests/twitter`
```
create_tweet           → write
get_tweet              → read
search_recent          → read
get_user_tweets        → read
get_user_by_username   → read
get_tweet_metrics      → read
```

#### `grantex/manifests/whatsapp`
```
send_template_message  → write
send_text_message      → write
send_media_message     → write
get_message_templates  → read
get_business_profile   → read
```

#### `grantex/manifests/youtube`
```
list_videos            → read
get_video_stats        → read
list_channel_videos    → read
get_channel_stats      → read
list_playlists         → read
get_video_analytics    → read
```

#### `grantex/manifests/langsmith`
```
list_runs              → read
get_run                → read
get_run_stats          → read
list_datasets          → read
create_feedback        → write
```

---

## CLI Commands

### `grantex manifest generate`

Auto-generate manifests from connector source code:

```bash
# Scan a single connector
grantex manifest generate ./connectors/marketing/salesforce.py
# → Generated manifest: salesforce (6 tools) → ./manifests/salesforce.json

# Scan all connectors recursively
grantex manifest generate ./connectors/ --recursive
# → Generated 54 manifests (340 tools) → ./manifests/

# Output as Python instead of JSON
grantex manifest generate ./connectors/ --format python
```

### `grantex manifest list`

```bash
grantex manifest list
# Available manifests (bundled):
#   salesforce         6 tools    marketing
#   hubspot           13 tools    marketing
#   jira              11 tools    ops
#   stripe             8 tools    finance
#   s3                 6 tools    comms
#   ... (54 total)

grantex manifest list --category finance
# Finance manifests:
#   banking_aa         5 tools
#   gstn               8 tools
#   netsuite           8 tools
#   ... (14 total, 88 tools)
```

### `grantex manifest validate`

```bash
grantex manifest validate --agent-tools create_lead,query,delete_contact --manifests salesforce
# ✓ create_lead   → write (salesforce)
# ✓ query         → read (salesforce)
# ✓ delete_contact → delete (salesforce)
# All 3 tools have manifest entries
```

### `grantex enforce test`

Dry-run scope enforcement:

```bash
grantex enforce test --token "eyJ..." --connector salesforce --tool delete_contact
# ❌ DENIED
# Token scopes: [tool:salesforce:write:*]
# Tool permission: delete (from manifest)
# Reason: write scope does not permit delete operations

grantex enforce test --token "eyJ..." --connector salesforce --tool create_lead
# ✅ ALLOWED
# Token scopes: [tool:salesforce:write:*]
# Tool permission: write (from manifest)
```

---

## Documentation Plan

### New Pages

| Page | Purpose |
|------|---------|
| `docs/guides/scope-enforcement.mdx` | Full guide: manifests → enforcer → LangChain → Express/FastAPI |
| `docs/sdks/typescript/enforce.mdx` | TS SDK `enforce()` API reference |
| `docs/sdks/python/enforce.mdx` | Python SDK `enforce()` API reference |
| `docs/cli/manifest.mdx` | CLI manifest commands |
| `docs/cli/enforce.mdx` | CLI enforce test command |
| `docs/concepts/tool-manifests.mdx` | What manifests are, permission hierarchy, custom manifests |
| `docs/case-studies/agenticorg.mdx` | AgenticOrg case study — 54 connectors, 340 tools, full integration walkthrough |

### Updates to Existing Pages

| Page | What to add |
|------|-------------|
| `README.md` | Scope enforcement section with `enforce()` examples + AgenticOrg reference |
| `docs/integrations/overview.mdx` | Scope Enforcement card |
| `llms.txt` | `enforce()`, `load_manifest()`, `wrap_tool()`, CLI commands, manifest list |
| `llms-full.txt` | Full API reference for all new methods |
| `web/index.html` | Scope enforcement visual workflow section |

### Landing Page Visual Workflow (for `web/index.html`)

Section: **"Scope Enforcement — From Token to Tool Call"**

```
Visual flow (left to right):

[Human Approves]     [Agent Gets Token]     [Tool Call]           [Enforcement]         [Connector]
   👤 ───────→          🤖 ───────→           🔧 ───────→          ✅/❌ ───────→          🏢
 "read contacts"    JWT with scopes       "delete_contact"     grantex.enforce()     Salesforce API
                    [scp: read:*]                              manifest: DELETE
                                                               scope: READ
                                                               → ❌ DENIED
```

Section: **"54 Pre-Built Manifests — Zero Configuration"**

```
Visual grid of connector logos with tool counts:

[Salesforce 6] [HubSpot 13] [Jira 11] [Stripe 8] [SAP 7] [S3 6]
[Gmail 4] [Slack 7] [GitHub 9] [Zendesk 8] [Okta 8] [Zoom 6]
... all 54

"Install the SDK. Load the manifest. Enforce in one line."
```

Section: **"Real-World: AgenticOrg"**

```
Quote/testimonial style:

"35 AI agents, 54 connectors, 340+ tools — all scope-enforced through
one grantex.enforce() call per tool execution."

— AgenticOrg (agenticorg.ai)
  AI Virtual Employee Platform
  Live in production
```

### `llms.txt` Additions

```
## Scope Enforcement

- `grantex.enforce(grant_token, connector, tool)` — verify token + check tool permission in one call
- `grantex.load_manifest(manifest)` / `grantex.load_manifests([...])` — load tool permission definitions
- `grantex.wrap_tool(langchain_tool, connector, tool, grant_token)` — wrap LangChain tool with auto-enforcement
- Pre-built manifests for 54 connectors: `from grantex.manifests.salesforce import manifest`
- Permission hierarchy: admin > delete > write > read
- CLI: `grantex manifest generate ./connectors/` — auto-generate from code
- CLI: `grantex manifest list` — browse available manifests
- CLI: `grantex enforce test --token X --connector salesforce --tool delete_contact` — dry-run
- Case study: AgenticOrg — 35 agents, 54 connectors, 340+ tools, all enforced via Grantex
```

---

## Portal UI Changes

### New Pages

- **`/dashboard/manifests`** — View all loaded manifests, search tools by name or connector, see permission levels (read/write/delete/admin) for each tool. Supports filtering by domain (Finance, HR, Marketing, Ops, Comms) and sorting by tool count.
- **`/dashboard/enforce-log`** — Real-time log of `enforce()` calls showing allowed/denied decisions per agent. Each entry shows: timestamp, agent DID, connector, tool, permission required, scopes held, result (allowed/denied), reason if denied. Supports filtering by agent, connector, and result.

### Updates to Existing Pages

- **`/dashboard/agents/:id`** — Show the agent's resolved scopes with permission levels derived from loaded manifests. For each connector the agent has access to, display which tools are allowed (green), denied (red), and which permission level each tool requires vs. what the agent's scope grants.
- **`/dashboard/grants/:id`** — Show which tools this grant allows/denies based on loaded manifests. Displays the grant's scopes mapped against all loaded manifests, with a tool-by-tool breakdown of allowed/denied status.

### API Modules Needed

- `api/manifests.ts` — CRUD for manifest management (list loaded manifests, get manifest by connector, search tools across manifests)
- `api/enforce-log.ts` — Query enforce log entries with pagination, filtering by agent/connector/result/time range

---

## Test Plan

### ToolManifest Tests (TS + Python)

- **Creation**: construct `ToolManifest` with connector name, description, version, and tools dict
- **from_file**: load from JSON file, load from YAML file, handle missing file, handle malformed JSON
- **add_tool**: add a new tool to existing manifest, overwrite existing tool permission, add tool with each permission level
- **get_permission**: return correct permission for known tool, return `None`/`undefined` for unknown tool
- **Permission.covers()**: `admin` covers all, `delete` covers `write` and `read`, `write` covers `read`, `read` covers only `read`
- **Invalid inputs**: empty connector name raises error, empty tools dict raises error, invalid permission string raises error, duplicate tool names within a manifest raises error

### enforce() Tests (TS + Python)

- Valid token + matching scope (write scope, write tool) -> allowed
- Valid token + higher scope (delete scope, write tool) -> allowed
- Valid token + insufficient scope (read scope, write tool) -> denied with reason
- Expired token -> denied with "token expired" reason
- Revoked token -> denied with "token revoked" reason
- Unknown connector (no manifest loaded) -> denied with "no manifest loaded" reason
- Unknown tool (manifest loaded but tool not in it) -> denied with "unknown tool" reason
- Capped scope with amount over cap -> denied with "budget exceeded" reason
- Permission hierarchy: write covers read, delete covers write, admin covers all
- No manifests loaded -> denied for any connector/tool
- Permissive enforce_mode: unknown tool -> allowed with warning

### wrapTool() Tests (TS + Python)

- Wraps a LangChain `StructuredTool` and returns a `StructuredTool`
- Denies execution if scope is insufficient (raises `PermissionError` / throws `Error`)
- Passes through to original tool if scope is sufficient
- Handles dynamic `grant_token` callback (called on each invocation)
- Handles token refresh (expired token triggers refresh before retry)

### CLI Tests

- `grantex manifest generate ./connectors/` -> parses tools from Python/TS source code, outputs JSON manifests
- `grantex manifest generate` with `--format python` -> outputs Python manifest files
- `grantex manifest list` -> shows all 54 bundled manifests with tool counts and categories
- `grantex manifest list --category finance` -> filters to finance domain only
- `grantex manifest validate --agent-tools X,Y --manifests Z` -> reports coverage (found/missing)
- `grantex enforce test --token X --connector Y --tool Z` -> dry-run check, outputs allowed/denied with reason

### Pre-Built Manifest Tests

- Each of 54 manifests loads without error
- Each manifest has the correct connector name matching its file/module name
- No duplicate tool names within any single manifest
- Every tool in every manifest has a valid permission (read/write/delete/admin)
- Tool counts match documented counts per connector
- All 6 domains are represented (Finance, HR, Marketing, Ops, Comms, Framework)

### Integration Test

Full end-to-end flow:
1. Load salesforce manifest
2. Create agent via SDK
3. Get grant token with `tool:salesforce:write:*` scope
4. `enforce(token, "salesforce", "create_lead")` -> allowed
5. `enforce(token, "salesforce", "delete_contact")` -> denied (write < delete)
6. Revoke token
7. `enforce(token, "salesforce", "create_lead")` -> denied (revoked)

### Portal Tests

- Manifest list page (`/dashboard/manifests`) renders all loaded manifests
- Manifest search filters results correctly
- Enforce log page (`/dashboard/enforce-log`) renders log entries with allowed/denied indicators
- Enforce log filtering by agent/connector works
- Agent detail page (`/dashboard/agents/:id`) shows resolved scopes with permission levels
- Grant detail page (`/dashboard/grants/:id`) shows tool-level allowed/denied breakdown

---

## README Changes

Add the following section to `README.md` (after the existing SDK usage section):

```markdown
## Scope Enforcement

Enforce tool-level permissions using pre-built manifests for 55+ enterprise connectors.

### Quick Start

\`\`\`python
from grantex import Grantex
from grantex.manifests.salesforce import manifest

grantex = Grantex(api_key="gx_...")
grantex.load_manifest(manifest)

result = grantex.enforce(grant_token=token, connector="salesforce", tool="delete_contact")
# result.allowed = False — "write scope does not permit delete operations"
\`\`\`

### Permission Hierarchy

| Scope Level | READ tools | WRITE tools | DELETE tools |
|:-----------:|:----------:|:-----------:|:------------:|
| read        | ✅         | ❌          | ❌           |
| write       | ✅         | ✅          | ❌           |
| delete      | ✅         | ✅          | ✅           |
| admin       | ✅         | ✅          | ✅           |

55 pre-built manifests: Salesforce, HubSpot, Jira, Stripe, SAP, S3, Gmail, Slack, GitHub, and 46 more.
Custom manifests: define inline or generate via CLI.
```

---

## Landing Page Changes

Add a new section to `web/index.html` with the following concept:

- **Section title**: "Scope Enforcement -- Control What Agents Can Do"
- **Visual**: Left side shows an agent making a tool call, middle shows the `enforce()` check with manifest lookup, right side shows allowed/denied result. Three-column flow diagram similar to the existing landing page visual style.
- **Below the visual**: Grid of 55 connector logos with tool counts (Salesforce 6, HubSpot 13, Jira 11, Stripe 8, etc.) arranged in a responsive grid.
- **CTA**: "See how AgenticOrg enforces 340+ tools -> Case Study" linking to `docs/case-studies/agenticorg`
- **Quote**: "35 agents, 55 connectors, 340+ tools -- one grantex.enforce() call" -- displayed in a testimonial/callout style

---

## llms.txt Additions

Append the following literal text to `llms.txt`:

```
## Scope Enforcement (v0.3.0+)
- `grantex.enforce(grant_token, connector, tool)` — verify JWT + check tool permission via manifest
- `grantex.load_manifest(manifest)` / `load_manifests([...])` — load tool permission definitions
- `grantex.wrap_tool(langchain_tool, connector, tool, grant_token)` — auto-enforce on LangChain tools
- `ToolManifest(connector, tools)` — define custom connector permissions
- `Permission.READ/WRITE/DELETE/ADMIN` — hierarchy: admin > delete > write > read
- 55 pre-built manifests: from grantex.manifests.salesforce import manifest
- CLI: grantex manifest generate ./connectors/ — auto-generate from code
- CLI: grantex manifest list — browse bundled manifests
- CLI: grantex enforce test --token X --connector Y --tool Z — dry-run
- Unknown tools denied by default (fail closed)
- Custom manifests: inline, JSON file, or extend pre-built
- Case study: AgenticOrg — 35 agents, 55 connectors, 340+ tools, all enforced
```

---

## Version Strategy

| Component | Version | Ships In |
|-----------|---------|----------|
| `enforce()`, `ToolManifest`, `Permission` | SDK v0.3.0 (TS), SDK v0.3.0 (Python) | `@grantex/sdk`, `grantex` PyPI |
| Pre-built manifests (54 connectors) | SDK v0.3.0 | Bundled with SDK (not separate packages) |
| CLI `manifest` / `enforce` commands | CLI v0.2.0 | `@grantex/cli` |
| Portal enforce UI (manifests page, enforce log) | Portal v0.2.0 | `apps/portal/` |

**Backward compatible** -- no breaking changes to existing SDK methods. All new functionality is additive:
- `enforce()`, `loadManifest()`, `loadManifests()`, `wrapTool()` are new methods on the existing `Grantex` client
- Existing `tokens.verify()`, `tokens.exchange()`, etc. are unchanged
- Manifests are opt-in: if no manifests are loaded, all existing behavior is identical
- CLI adds new subcommands (`manifest`, `enforce`) without modifying existing commands

---

## Connector Count Note

The document references **54 production connectors** with pre-built manifests. This count reflects the 54 unique connector manifests shipped with the SDK. Note that `gstn_sandbox` is a sandbox variant of `gstn` and reuses the `gstn` manifest -- it is not counted as a separate manifest. The `aa_consent` helper is part of the `banking_aa` connector flow and also does not have its own manifest. When marketing materials reference "55+ connectors," this includes the sandbox variant for completeness.

---

## Implementation Order

| Step | What | Effort |
|------|------|--------|
| 1 | `ToolManifest` + `Permission` classes in TS + Python SDKs | 1 day |
| 2 | `enforce()` + `load_manifest()` on `Grantex` client | 2 days |
| 3 | All 54 pre-built manifests (from AgenticOrg connector inventory above) | 2 days |
| 4 | `wrap_tool()` for LangChain in both SDKs | 1 day |
| 5 | CLI: `manifest generate`, `manifest list`, `manifest validate`, `enforce test` | 2 days |
| 6 | Express/FastAPI middleware helpers | 1 day |
| 7 | Documentation: guides, API ref, case study, llms.txt | 2 days |
| 8 | Landing page visual workflow section | 1 day |
| 9 | Publish new SDK versions to npm/PyPI | 1 day |

Total: ~13 days.

---

## Totals

| Metric | Count |
|--------|:---:|
| Connectors with manifests | **54** |
| Tools mapped | **340+** |
| Domains covered | **6** (Finance, HR, Marketing, Ops, Comms, Framework) |
| New SDK methods | **4** (enforce, loadManifest, loadManifests, wrapTool) |
| New CLI commands | **4** (manifest generate/list/validate, enforce test) |
| New doc pages | **7** |
| Updated doc pages | **5** |
