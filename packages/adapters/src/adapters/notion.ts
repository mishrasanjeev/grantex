import { BaseAdapter } from '../base-adapter.js';
import { GrantexAdapterError } from '../errors.js';
import type { AdapterConfig, AdapterResult, QueryDatabaseParams, CreatePageParams } from '../types.js';

const NOTION_API = 'https://api.notion.com/v1';

export class NotionAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super(config);
  }

  async queryDatabase(
    token: string,
    params: QueryDatabaseParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'pages:read');
    const credential = await this.resolveCredential();

    const url = `${NOTION_API}/databases/${encodeURIComponent(params.database_id)}/query`;

    const body: Record<string, unknown> = {
      ...(params.filter !== undefined ? { filter: params.filter } : {}),
      ...(params.sorts !== undefined ? { sorts: params.sorts } : {}),
      ...(params.page_size !== undefined ? { page_size: params.page_size } : {}),
      ...(params.start_cursor !== undefined ? { start_cursor: params.start_cursor } : {}),
    };

    try {
      const data = await this.callUpstream(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify(body),
      });
      await this.logAudit(grant, 'pages:queryDatabase', 'success', {
        databaseId: params.database_id,
      });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'pages:queryDatabase', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Notion query failed: ${String(err)}`);
    }
  }

  async createPage(
    token: string,
    params: CreatePageParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'pages:write');
    const credential = await this.resolveCredential();

    const url = `${NOTION_API}/pages`;

    const body: Record<string, unknown> = {
      parent: params.parent,
      properties: params.properties,
      ...(params.children !== undefined ? { children: params.children } : {}),
    };

    try {
      const data = await this.callUpstream(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify(body),
      });
      await this.logAudit(grant, 'pages:createPage', 'success');
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'pages:createPage', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Notion create page failed: ${String(err)}`);
    }
  }
}
