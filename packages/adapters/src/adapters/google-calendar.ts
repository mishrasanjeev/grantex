import type { AdapterConfig, AdapterResult, ListEventsParams, CreateEventParams } from '../types.js';
import { BaseAdapter } from '../base-adapter.js';
import { GrantexAdapterError } from '../errors.js';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export class GoogleCalendarAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super(config);
  }

  async listEvents(
    token: string,
    params: ListEventsParams = {},
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'calendar:read');
    const credential = await this.resolveCredential();

    const calendarId = encodeURIComponent(params.calendarId ?? 'primary');
    const query = new URLSearchParams();
    if (params.timeMin) query.set('timeMin', params.timeMin);
    if (params.timeMax) query.set('timeMax', params.timeMax);
    if (params.maxResults) query.set('maxResults', String(params.maxResults));

    const qs = query.toString();
    const url = `${CALENDAR_API}/calendars/${calendarId}/events${qs ? `?${qs}` : ''}`;

    try {
      const data = await this.callUpstream(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
      });
      await this.logAudit(grant, 'calendar:listEvents', 'success', { calendarId: params.calendarId ?? 'primary' });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'calendar:listEvents', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Calendar list failed: ${String(err)}`);
    }
  }

  async createEvent(
    token: string,
    params: CreateEventParams,
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'calendar:write');
    const credential = await this.resolveCredential();

    const calendarId = encodeURIComponent(params.calendarId ?? 'primary');
    const url = `${CALENDAR_API}/calendars/${calendarId}/events`;

    const body = {
      summary: params.summary,
      start: params.start,
      end: params.end,
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.attendees !== undefined ? { attendees: params.attendees } : {}),
    };

    try {
      const data = await this.callUpstream(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      await this.logAudit(grant, 'calendar:createEvent', 'success', { calendarId: params.calendarId ?? 'primary' });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'calendar:createEvent', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Calendar create failed: ${String(err)}`);
    }
  }
}
