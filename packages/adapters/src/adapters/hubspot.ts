import { BaseAdapter } from '../base-adapter.js';
import { GrantexAdapterError } from '../errors.js';
import type { AdapterConfig, AdapterResult, ListContactsParams, CreateContactParams } from '../types.js';

const HUBSPOT_API = 'https://api.hubapi.com';

export class HubSpotAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super(config);
  }

  async listContacts(
    token: string,
    params: ListContactsParams = {},
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'contacts:read');
    const credential = await this.resolveCredential();

    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.after) query.set('after', params.after);
    if (params.properties) {
      for (const prop of params.properties) {
        query.append('properties', prop);
      }
    }

    const qs = query.toString();
    const url = `${HUBSPOT_API}/crm/v3/objects/contacts${qs ? `?${qs}` : ''}`;

    try {
      const data = await this.callUpstream(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
      });
      await this.logAudit(grant, 'contacts:listContacts', 'success');
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'contacts:listContacts', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `HubSpot list failed: ${String(err)}`);
    }
  }

  async createContact(
    token: string,
    params: CreateContactParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'contacts:write');
    const credential = await this.resolveCredential();

    const url = `${HUBSPOT_API}/crm/v3/objects/contacts`;

    const properties: Record<string, string> = {
      email: params.email,
      ...(params.firstname !== undefined ? { firstname: params.firstname } : {}),
      ...(params.lastname !== undefined ? { lastname: params.lastname } : {}),
      ...(params.phone !== undefined ? { phone: params.phone } : {}),
      ...(params.company !== undefined ? { company: params.company } : {}),
      ...(params.properties !== undefined ? params.properties : {}),
    };

    try {
      const data = await this.callUpstream(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties }),
      });
      await this.logAudit(grant, 'contacts:createContact', 'success', { email: params.email });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'contacts:createContact', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `HubSpot create failed: ${String(err)}`);
    }
  }
}
