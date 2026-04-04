// Manifest data is static (bundled in SDK), no API calls needed

export interface ManifestEntry {
  connector: string;
  category: string;
  tools: number;
  description: string;
}

export const BUNDLED_MANIFESTS: ManifestEntry[] = [
  // Finance
  { connector: 'banking_aa', category: 'finance', tools: 5, description: 'Banking Account Aggregator API' },
  { connector: 'gstn', category: 'finance', tools: 8, description: 'GST Network (India) API' },
  { connector: 'netsuite', category: 'finance', tools: 8, description: 'Oracle NetSuite ERP API' },
  { connector: 'oracle_fusion', category: 'finance', tools: 10, description: 'Oracle Fusion Cloud ERP API' },
  { connector: 'quickbooks', category: 'finance', tools: 6, description: 'QuickBooks Online Accounting API' },
  { connector: 'sap', category: 'finance', tools: 7, description: 'SAP S/4HANA REST API' },
  { connector: 'stripe', category: 'finance', tools: 8, description: 'Stripe Payments API' },
  { connector: 'tally', category: 'finance', tools: 6, description: 'Tally Prime Accounting API' },
  { connector: 'zoho_books', category: 'finance', tools: 7, description: 'Zoho Books Accounting API' },
  { connector: 'pinelabs_plural', category: 'finance', tools: 6, description: 'Pine Labs Plural Payments API' },
  { connector: 'income_tax_india', category: 'finance', tools: 7, description: 'India Income Tax e-Filing API' },
  // HR
  { connector: 'darwinbox', category: 'hr', tools: 10, description: 'Darwinbox HRMS API' },
  { connector: 'docusign', category: 'hr', tools: 6, description: 'DocuSign eSignature API' },
  { connector: 'epfo', category: 'hr', tools: 6, description: 'EPFO (India Provident Fund) API' },
  { connector: 'greenhouse', category: 'hr', tools: 8, description: 'Greenhouse Recruiting API' },
  { connector: 'keka', category: 'hr', tools: 6, description: 'Keka HRMS API' },
  { connector: 'linkedin_talent', category: 'hr', tools: 6, description: 'LinkedIn Talent Solutions API' },
  { connector: 'okta', category: 'hr', tools: 8, description: 'Okta Identity Management API' },
  { connector: 'zoom', category: 'hr', tools: 6, description: 'Zoom Meetings & Webinars API' },
  // Marketing
  { connector: 'salesforce', category: 'marketing', tools: 6, description: 'Salesforce CRM REST API' },
  { connector: 'hubspot', category: 'marketing', tools: 13, description: 'HubSpot CRM API' },
  { connector: 'mailchimp', category: 'marketing', tools: 10, description: 'Mailchimp Email Marketing API' },
  { connector: 'google_ads', category: 'marketing', tools: 5, description: 'Google Ads API' },
  { connector: 'meta_ads', category: 'marketing', tools: 5, description: 'Meta (Facebook) Ads API' },
  { connector: 'linkedin_ads', category: 'marketing', tools: 4, description: 'LinkedIn Ads Campaign API' },
  { connector: 'ga4', category: 'marketing', tools: 6, description: 'Google Analytics 4 Data API' },
  { connector: 'mixpanel', category: 'marketing', tools: 5, description: 'Mixpanel Analytics API' },
  { connector: 'moengage', category: 'marketing', tools: 6, description: 'MoEngage Customer Engagement API' },
  { connector: 'ahrefs', category: 'marketing', tools: 5, description: 'Ahrefs SEO API' },
  { connector: 'bombora', category: 'marketing', tools: 4, description: 'Bombora Intent Data API' },
  { connector: 'brandwatch', category: 'marketing', tools: 5, description: 'Brandwatch Social Listening API' },
  { connector: 'buffer', category: 'marketing', tools: 5, description: 'Buffer Social Media API' },
  { connector: 'g2', category: 'marketing', tools: 4, description: 'G2 Review Platform API' },
  { connector: 'trustradius', category: 'marketing', tools: 4, description: 'TrustRadius Review API' },
  { connector: 'wordpress', category: 'marketing', tools: 7, description: 'WordPress REST API' },
  // Ops
  { connector: 'jira', category: 'ops', tools: 11, description: 'Jira Software REST API' },
  { connector: 'confluence', category: 'ops', tools: 6, description: 'Confluence Wiki REST API' },
  { connector: 'servicenow', category: 'ops', tools: 6, description: 'ServiceNow ITSM API' },
  { connector: 'zendesk', category: 'ops', tools: 8, description: 'Zendesk Support API' },
  { connector: 'pagerduty', category: 'ops', tools: 6, description: 'PagerDuty Incident Management API' },
  { connector: 'sanctions_api', category: 'ops', tools: 5, description: 'Sanctions Screening API' },
  { connector: 'mca_portal', category: 'ops', tools: 4, description: 'MCA (India Company Registry) API' },
  // Comms
  { connector: 'gmail', category: 'comms', tools: 4, description: 'Gmail REST API' },
  { connector: 'slack', category: 'comms', tools: 7, description: 'Slack Web API' },
  { connector: 'github', category: 'comms', tools: 9, description: 'GitHub REST API' },
  { connector: 'google_calendar', category: 'comms', tools: 5, description: 'Google Calendar API' },
  { connector: 's3', category: 'comms', tools: 6, description: 'AWS S3 Object Storage API' },
  { connector: 'sendgrid', category: 'comms', tools: 7, description: 'SendGrid Email API' },
  { connector: 'twilio', category: 'comms', tools: 5, description: 'Twilio Messaging API' },
  { connector: 'twitter', category: 'comms', tools: 6, description: 'Twitter / X API' },
  { connector: 'whatsapp', category: 'comms', tools: 5, description: 'WhatsApp Business API' },
  { connector: 'youtube', category: 'comms', tools: 6, description: 'YouTube Data API' },
  { connector: 'langsmith', category: 'comms', tools: 5, description: 'LangSmith Tracing API' },
];

export const CATEGORIES = ['all', 'finance', 'hr', 'marketing', 'ops', 'comms'] as const;
export type Category = (typeof CATEGORIES)[number];
