import type { AdapterConfig, AdapterResult, SlackSendMessageParams, SlackListMessagesParams } from '../types.js';
import { BaseAdapter } from '../base-adapter.js';
import { GrantexAdapterError } from '../errors.js';

const SLACK_API = 'https://slack.com/api';

export class SlackAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super(config);
  }

  async sendMessage(
    token: string,
    params: SlackSendMessageParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'notifications:send');
    const credential = await this.resolveCredential();

    const url = `${SLACK_API}/chat.postMessage`;

    const body: Record<string, unknown> = {
      channel: params.channel,
      text: params.text,
    };
    if (params.thread_ts !== undefined) {
      body['thread_ts'] = params.thread_ts;
    }

    try {
      const data = await this.callUpstream<{ ok: boolean; error?: string }>(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      // Slack returns 200 even for errors, check the `ok` field
      if (!data.ok) {
        throw new GrantexAdapterError('UPSTREAM_ERROR', `Slack API error: ${data.error ?? 'unknown'}`);
      }

      await this.logAudit(grant, 'notifications:sendMessage', 'success', { channel: params.channel });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'notifications:sendMessage', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Slack send failed: ${String(err)}`);
    }
  }

  async listMessages(
    token: string,
    params: SlackListMessagesParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'notifications:read');
    const credential = await this.resolveCredential();

    const query = new URLSearchParams();
    query.set('channel', params.channel);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.oldest) query.set('oldest', params.oldest);
    if (params.latest) query.set('latest', params.latest);

    const url = `${SLACK_API}/conversations.history?${query.toString()}`;

    try {
      const data = await this.callUpstream<{ ok: boolean; error?: string }>(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
      });

      if (!data.ok) {
        throw new GrantexAdapterError('UPSTREAM_ERROR', `Slack API error: ${data.error ?? 'unknown'}`);
      }

      await this.logAudit(grant, 'notifications:listMessages', 'success', { channel: params.channel });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'notifications:listMessages', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Slack list failed: ${String(err)}`);
    }
  }
}
