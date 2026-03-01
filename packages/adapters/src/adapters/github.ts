import { BaseAdapter } from '../base-adapter.js';
import { GrantexAdapterError } from '../errors.js';
import type { AdapterConfig, AdapterResult, ListRepositoriesParams, CreateIssueParams } from '../types.js';

const GITHUB_API = 'https://api.github.com';

export class GitHubAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super(config);
  }

  async listRepositories(
    token: string,
    params: ListRepositoriesParams = {},
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'repos:read');
    const credential = await this.resolveCredential();

    const query = new URLSearchParams();
    if (params.sort) query.set('sort', params.sort);
    if (params.direction) query.set('direction', params.direction);
    if (params.per_page) query.set('per_page', String(params.per_page));
    if (params.page) query.set('page', String(params.page));

    const qs = query.toString();
    const url = `${GITHUB_API}/user/repos${qs ? `?${qs}` : ''}`;

    try {
      const data = await this.callUpstream(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: 'application/vnd.github+json',
        },
      });
      await this.logAudit(grant, 'repos:listRepositories', 'success');
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'repos:listRepositories', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `GitHub list failed: ${String(err)}`);
    }
  }

  async createIssue(
    token: string,
    params: CreateIssueParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'issues:write');
    const credential = await this.resolveCredential();

    const url = `${GITHUB_API}/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues`;

    const body: Record<string, unknown> = {
      title: params.title,
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.labels !== undefined ? { labels: params.labels } : {}),
      ...(params.assignees !== undefined ? { assignees: params.assignees } : {}),
    };

    try {
      const data = await this.callUpstream(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      await this.logAudit(grant, 'issues:createIssue', 'success', {
        owner: params.owner,
        repo: params.repo,
      });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'issues:createIssue', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `GitHub create issue failed: ${String(err)}`);
    }
  }
}
