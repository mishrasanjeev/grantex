"""Pre-built tool manifests for common enterprise connectors."""

# Finance
from grantex.manifests.banking_aa import manifest as banking_aa_manifest
from grantex.manifests.gstn import manifest as gstn_manifest
from grantex.manifests.netsuite import manifest as netsuite_manifest
from grantex.manifests.oracle_fusion import manifest as oracle_fusion_manifest
from grantex.manifests.quickbooks import manifest as quickbooks_manifest
from grantex.manifests.sap import manifest as sap_manifest
from grantex.manifests.stripe import manifest as stripe_manifest
from grantex.manifests.tally import manifest as tally_manifest
from grantex.manifests.zoho_books import manifest as zoho_books_manifest
from grantex.manifests.pinelabs_plural import manifest as pinelabs_plural_manifest
from grantex.manifests.income_tax_india import manifest as income_tax_india_manifest

# HR
from grantex.manifests.darwinbox import manifest as darwinbox_manifest
from grantex.manifests.docusign import manifest as docusign_manifest
from grantex.manifests.epfo import manifest as epfo_manifest
from grantex.manifests.greenhouse import manifest as greenhouse_manifest
from grantex.manifests.keka import manifest as keka_manifest
from grantex.manifests.linkedin_talent import manifest as linkedin_talent_manifest
from grantex.manifests.okta import manifest as okta_manifest
from grantex.manifests.zoom import manifest as zoom_manifest

# Marketing
from grantex.manifests.salesforce import manifest as salesforce_manifest
from grantex.manifests.hubspot import manifest as hubspot_manifest
from grantex.manifests.mailchimp import manifest as mailchimp_manifest
from grantex.manifests.google_ads import manifest as google_ads_manifest
from grantex.manifests.meta_ads import manifest as meta_ads_manifest
from grantex.manifests.linkedin_ads import manifest as linkedin_ads_manifest
from grantex.manifests.ga4 import manifest as ga4_manifest
from grantex.manifests.mixpanel import manifest as mixpanel_manifest
from grantex.manifests.moengage import manifest as moengage_manifest
from grantex.manifests.ahrefs import manifest as ahrefs_manifest
from grantex.manifests.bombora import manifest as bombora_manifest
from grantex.manifests.brandwatch import manifest as brandwatch_manifest
from grantex.manifests.buffer import manifest as buffer_manifest
from grantex.manifests.g2 import manifest as g2_manifest
from grantex.manifests.trustradius import manifest as trustradius_manifest
from grantex.manifests.wordpress import manifest as wordpress_manifest

# Ops
from grantex.manifests.jira import manifest as jira_manifest
from grantex.manifests.confluence import manifest as confluence_manifest
from grantex.manifests.servicenow import manifest as servicenow_manifest
from grantex.manifests.zendesk import manifest as zendesk_manifest
from grantex.manifests.pagerduty import manifest as pagerduty_manifest
from grantex.manifests.sanctions_api import manifest as sanctions_api_manifest
from grantex.manifests.mca_portal import manifest as mca_portal_manifest

# Comms
from grantex.manifests.gmail import manifest as gmail_manifest
from grantex.manifests.slack import manifest as slack_manifest
from grantex.manifests.github import manifest as github_manifest
from grantex.manifests.google_calendar import manifest as google_calendar_manifest
from grantex.manifests.s3 import manifest as s3_manifest
from grantex.manifests.sendgrid import manifest as sendgrid_manifest
from grantex.manifests.twilio import manifest as twilio_manifest
from grantex.manifests.twitter import manifest as twitter_manifest
from grantex.manifests.whatsapp import manifest as whatsapp_manifest
from grantex.manifests.youtube import manifest as youtube_manifest
from grantex.manifests.langsmith import manifest as langsmith_manifest

__all__ = [
    # Finance
    "banking_aa_manifest",
    "gstn_manifest",
    "netsuite_manifest",
    "oracle_fusion_manifest",
    "quickbooks_manifest",
    "sap_manifest",
    "stripe_manifest",
    "tally_manifest",
    "zoho_books_manifest",
    "pinelabs_plural_manifest",
    "income_tax_india_manifest",
    # HR
    "darwinbox_manifest",
    "docusign_manifest",
    "epfo_manifest",
    "greenhouse_manifest",
    "keka_manifest",
    "linkedin_talent_manifest",
    "okta_manifest",
    "zoom_manifest",
    # Marketing
    "salesforce_manifest",
    "hubspot_manifest",
    "mailchimp_manifest",
    "google_ads_manifest",
    "meta_ads_manifest",
    "linkedin_ads_manifest",
    "ga4_manifest",
    "mixpanel_manifest",
    "moengage_manifest",
    "ahrefs_manifest",
    "bombora_manifest",
    "brandwatch_manifest",
    "buffer_manifest",
    "g2_manifest",
    "trustradius_manifest",
    "wordpress_manifest",
    # Ops
    "jira_manifest",
    "confluence_manifest",
    "servicenow_manifest",
    "zendesk_manifest",
    "pagerduty_manifest",
    "sanctions_api_manifest",
    "mca_portal_manifest",
    # Comms
    "gmail_manifest",
    "slack_manifest",
    "github_manifest",
    "google_calendar_manifest",
    "s3_manifest",
    "sendgrid_manifest",
    "twilio_manifest",
    "twitter_manifest",
    "whatsapp_manifest",
    "youtube_manifest",
    "langsmith_manifest",
]
