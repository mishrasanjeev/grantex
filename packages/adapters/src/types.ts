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
