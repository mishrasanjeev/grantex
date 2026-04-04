import { ToolManifest, Permission } from '../manifest.js';

export const servicenowManifest = new ToolManifest({
  connector: 'servicenow',
  description: 'ServiceNow ITSM API',
  tools: {
    create_incident: Permission.WRITE,
    update_incident: Permission.WRITE,
    submit_change_request: Permission.WRITE,
    get_cmdb_ci: Permission.READ,
    check_sla_status: Permission.READ,
    get_kb_article: Permission.READ,
  },
});
