import { BaseAdapter } from '../base-adapter.js';
import { GrantexAdapterError } from '../errors.js';
import type { AdapterResult, QueryRecordsParams, CreateRecordParams, SalesforceAdapterConfig } from '../types.js';

export class SalesforceAdapter extends BaseAdapter {
  readonly #instanceUrl: string;

  constructor(config: SalesforceAdapterConfig) {
    super(config);
    this.#instanceUrl = config.instanceUrl.replace(/\/$/, '');
  }

  async queryRecords(
    token: string,
    params: QueryRecordsParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'crm:read');
    const credential = await this.resolveCredential();

    const url = `${this.#instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(params.query)}`;

    try {
      const data = await this.callUpstream(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
      });
      await this.logAudit(grant, 'crm:queryRecords', 'success');
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'crm:queryRecords', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Salesforce query failed: ${String(err)}`);
    }
  }

  async createRecord(
    token: string,
    params: CreateRecordParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'crm:write');
    const credential = await this.resolveCredential();

    const url = `${this.#instanceUrl}/services/data/v59.0/sobjects/${encodeURIComponent(params.sobject)}`;

    try {
      const data = await this.callUpstream(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params.fields),
      });
      await this.logAudit(grant, 'crm:createRecord', 'success', { sobject: params.sobject });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'crm:createRecord', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Salesforce create failed: ${String(err)}`);
    }
  }
}
