import type { VerifiedGrant, LogAuditParams } from '@grantex/sdk';

export type CredentialProvider = string | (() => string | Promise<string>);

export type AuditLogger = (params: LogAuditParams) => Promise<void>;

export interface AdapterConfig {
  jwksUri: string;
  credentials: CredentialProvider;
  auditLogger?: AuditLogger;
  clockTolerance?: number;
  timeout?: number;
}

export interface AdapterResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  grant: VerifiedGrant;
}

// Google Calendar types
export interface ListEventsParams {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
}

export interface CreateEventParams {
  calendarId?: string;
  summary: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  description?: string;
  attendees?: Array<{ email: string }>;
}

// Gmail types
export interface ListMessagesParams {
  q?: string;
  maxResults?: number;
  labelIds?: string[];
}

export interface SendMessageParams {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}

// Stripe types
export interface ListPaymentIntentsParams {
  limit?: number;
  customer?: string;
  starting_after?: string;
}

export interface CreatePaymentIntentParams {
  amount: number;
  currency: string;
  customer?: string;
  description?: string;
  metadata?: Record<string, string>;
}

// Slack types
export interface SlackSendMessageParams {
  channel: string;
  text: string;
  thread_ts?: string;
}

export interface SlackListMessagesParams {
  channel: string;
  limit?: number;
  oldest?: string;
  latest?: string;
}

// Google Drive types
export interface ListFilesParams {
  q?: string;
  pageSize?: number;
  pageToken?: string;
  fields?: string;
}

export interface UploadFileParams {
  name: string;
  mimeType: string;
  content: string | Buffer;
  parents?: string[];
  description?: string;
}

// GitHub types
export interface ListRepositoriesParams {
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  direction?: 'asc' | 'desc';
  per_page?: number;
  page?: number;
}

export interface CreateIssueParams {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

// Notion types
export interface QueryDatabaseParams {
  database_id: string;
  filter?: Record<string, unknown>;
  sorts?: Array<Record<string, unknown>>;
  page_size?: number;
  start_cursor?: string;
}

export interface CreatePageParams {
  parent: { database_id: string } | { page_id: string };
  properties: Record<string, unknown>;
  children?: Array<Record<string, unknown>>;
}

// HubSpot types
export interface ListContactsParams {
  limit?: number;
  after?: string;
  properties?: string[];
}

export interface CreateContactParams {
  email: string;
  firstname?: string;
  lastname?: string;
  phone?: string;
  company?: string;
  properties?: Record<string, string>;
}

// Salesforce types
export interface SalesforceAdapterConfig extends AdapterConfig {
  instanceUrl: string;
}

export interface QueryRecordsParams {
  query: string;
}

export interface CreateRecordParams {
  sobject: string;
  fields: Record<string, unknown>;
}

// Linear types
export interface ListIssuesParams {
  teamId?: string;
  first?: number;
  after?: string;
  filter?: Record<string, unknown>;
}

export interface LinearCreateIssueParams {
  teamId: string;
  title: string;
  description?: string;
  priority?: number;
  assigneeId?: string;
  labelIds?: string[];
}

// Jira types
export interface JiraAdapterConfig extends AdapterConfig {
  baseUrl: string;
}

export interface SearchIssuesParams {
  jql: string;
  maxResults?: number;
  startAt?: number;
  fields?: string[];
}

export interface JiraCreateIssueParams {
  projectKey: string;
  summary: string;
  issueType: string;
  description?: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
}
