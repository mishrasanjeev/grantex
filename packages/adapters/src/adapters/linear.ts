import { BaseAdapter } from '../base-adapter.js';
import { GrantexAdapterError } from '../errors.js';
import type { AdapterConfig, AdapterResult, ListIssuesParams, LinearCreateIssueParams } from '../types.js';

const LINEAR_API = 'https://api.linear.app/graphql';

export class LinearAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super(config);
  }

  async listIssues(
    token: string,
    params: ListIssuesParams = {},
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'issues:read');
    const credential = await this.resolveCredential();

    const variables: Record<string, unknown> = {
      ...(params.first !== undefined ? { first: params.first } : {}),
      ...(params.after !== undefined ? { after: params.after } : {}),
      ...(params.filter !== undefined ? { filter: params.filter } : {}),
    };

    if (params.teamId) {
      variables['filter'] = {
        ...(typeof variables['filter'] === 'object' && variables['filter'] !== null
          ? variables['filter'] as Record<string, unknown>
          : {}),
        team: { id: { eq: params.teamId } },
      };
    }

    const query = `query ListIssues($first: Int, $after: String, $filter: IssueFilter) {
      issues(first: $first, after: $after, filter: $filter) {
        nodes { id identifier title state { name } priority assignee { name } createdAt updatedAt }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    try {
      const data = await this.callUpstream(LINEAR_API, {
        method: 'POST',
        headers: {
          Authorization: credential,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
      await this.logAudit(grant, 'issues:listIssues', 'success');
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'issues:listIssues', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Linear list failed: ${String(err)}`);
    }
  }

  async createIssue(
    token: string,
    params: LinearCreateIssueParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'issues:write');
    const credential = await this.resolveCredential();

    const input: Record<string, unknown> = {
      teamId: params.teamId,
      title: params.title,
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.priority !== undefined ? { priority: params.priority } : {}),
      ...(params.assigneeId !== undefined ? { assigneeId: params.assigneeId } : {}),
      ...(params.labelIds !== undefined ? { labelIds: params.labelIds } : {}),
    };

    const query = `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier title state { name } priority createdAt }
      }
    }`;

    try {
      const data = await this.callUpstream(LINEAR_API, {
        method: 'POST',
        headers: {
          Authorization: credential,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables: { input } }),
      });
      await this.logAudit(grant, 'issues:createIssue', 'success', { teamId: params.teamId });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'issues:createIssue', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Linear create failed: ${String(err)}`);
    }
  }
}
