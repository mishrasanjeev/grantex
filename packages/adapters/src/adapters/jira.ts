import { BaseAdapter } from '../base-adapter.js';
import { GrantexAdapterError } from '../errors.js';
import type { AdapterResult, SearchIssuesParams, JiraCreateIssueParams, JiraAdapterConfig } from '../types.js';

export class JiraAdapter extends BaseAdapter {
  readonly #baseUrl: string;

  constructor(config: JiraAdapterConfig) {
    super(config);
    this.#baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  async searchIssues(
    token: string,
    params: SearchIssuesParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'issues:read');
    const credential = await this.resolveCredential();

    const url = `${this.#baseUrl}/rest/api/3/search`;

    const body: Record<string, unknown> = {
      jql: params.jql,
      ...(params.maxResults !== undefined ? { maxResults: params.maxResults } : {}),
      ...(params.startAt !== undefined ? { startAt: params.startAt } : {}),
      ...(params.fields !== undefined ? { fields: params.fields } : {}),
    };

    try {
      const data = await this.callUpstream(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      await this.logAudit(grant, 'issues:searchIssues', 'success');
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'issues:searchIssues', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Jira search failed: ${String(err)}`);
    }
  }

  async createIssue(
    token: string,
    params: JiraCreateIssueParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'issues:write');
    const credential = await this.resolveCredential();

    const url = `${this.#baseUrl}/rest/api/3/issue`;

    const fields: Record<string, unknown> = {
      project: { key: params.projectKey },
      summary: params.summary,
      issuetype: { name: params.issueType },
      ...(params.description !== undefined
        ? {
            description: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: params.description }],
                },
              ],
            },
          }
        : {}),
      ...(params.priority !== undefined ? { priority: { name: params.priority } } : {}),
      ...(params.assignee !== undefined ? { assignee: { id: params.assignee } } : {}),
      ...(params.labels !== undefined ? { labels: params.labels } : {}),
    };

    try {
      const data = await this.callUpstream(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      });
      await this.logAudit(grant, 'issues:createIssue', 'success', {
        projectKey: params.projectKey,
      });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'issues:createIssue', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Jira create failed: ${String(err)}`);
    }
  }
}
