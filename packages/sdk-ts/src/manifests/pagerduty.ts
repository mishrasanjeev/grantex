import { ToolManifest, Permission } from '../manifest.js';

export const pagerdutyManifest = new ToolManifest({
  connector: 'pagerduty',
  description: 'PagerDuty Incident Management API',
  tools: {
    create_incident: Permission.WRITE,
    acknowledge_incident: Permission.WRITE,
    resolve_incident: Permission.WRITE,
    get_on_call: Permission.READ,
    list_incidents: Permission.READ,
    create_postmortem: Permission.WRITE,
  },
});
