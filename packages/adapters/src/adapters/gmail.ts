import type { AdapterConfig, AdapterResult, ListMessagesParams, SendMessageParams } from '../types.js';
import { BaseAdapter } from '../base-adapter.js';
import { GrantexAdapterError } from '../errors.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

export class GmailAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super(config);
  }

  async listMessages(
    token: string,
    params: ListMessagesParams = {},
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'email:read');
    const credential = await this.resolveCredential();

    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.maxResults) query.set('maxResults', String(params.maxResults));
    if (params.labelIds) {
      for (const label of params.labelIds) {
        query.append('labelIds', label);
      }
    }

    const qs = query.toString();
    const url = `${GMAIL_API}/users/me/messages${qs ? `?${qs}` : ''}`;

    try {
      const data = await this.callUpstream(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
      });
      await this.logAudit(grant, 'email:listMessages', 'success');
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'email:listMessages', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Gmail list failed: ${String(err)}`);
    }
  }

  async sendMessage(
    token: string,
    params: SendMessageParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'email:send');
    const credential = await this.resolveCredential();

    const mimeLines = [
      `To: ${params.to}`,
      `Subject: ${params.subject}`,
      ...(params.cc !== undefined ? [`Cc: ${params.cc}`] : []),
      ...(params.bcc !== undefined ? [`Bcc: ${params.bcc}`] : []),
      'Content-Type: text/plain; charset=utf-8',
      '',
      params.body,
    ];
    const raw = Buffer.from(mimeLines.join('\r\n')).toString('base64url');

    const url = `${GMAIL_API}/users/me/messages/send`;

    try {
      const data = await this.callUpstream(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      });
      await this.logAudit(grant, 'email:sendMessage', 'success', { to: params.to });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'email:sendMessage', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Gmail send failed: ${String(err)}`);
    }
  }
}
