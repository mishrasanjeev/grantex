import { BaseAdapter } from '../base-adapter.js';
import { GrantexAdapterError } from '../errors.js';
import type { AdapterConfig, AdapterResult, ListFilesParams, UploadFileParams } from '../types.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export class GoogleDriveAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super(config);
  }

  async listFiles(
    token: string,
    params: ListFilesParams = {},
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'files:read');
    const credential = await this.resolveCredential();

    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.pageSize) query.set('pageSize', String(params.pageSize));
    if (params.pageToken) query.set('pageToken', params.pageToken);
    if (params.fields) query.set('fields', params.fields);

    const qs = query.toString();
    const url = `${DRIVE_API}/files${qs ? `?${qs}` : ''}`;

    try {
      const data = await this.callUpstream(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
      });
      await this.logAudit(grant, 'files:listFiles', 'success');
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'files:listFiles', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Drive list failed: ${String(err)}`);
    }
  }

  async uploadFile(
    token: string,
    params: UploadFileParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'files:write');
    const credential = await this.resolveCredential();

    const metadata: Record<string, unknown> = {
      name: params.name,
      mimeType: params.mimeType,
      ...(params.parents !== undefined ? { parents: params.parents } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
    };

    const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

    const boundary = 'grantex_boundary';
    const body =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\n` +
      `Content-Type: ${params.mimeType}\r\n\r\n` +
      String(params.content) +
      `\r\n--${boundary}--`;

    try {
      const data = await this.callUpstream(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
      await this.logAudit(grant, 'files:uploadFile', 'success', { name: params.name });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'files:uploadFile', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Drive upload failed: ${String(err)}`);
    }
  }
}
