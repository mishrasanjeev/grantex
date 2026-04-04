import { ToolManifest, Permission } from '../manifest.js';

export const salesforceManifest = new ToolManifest({
  connector: 'salesforce',
  description: 'Salesforce CRM REST API',
  tools: {
    create_lead: Permission.WRITE,
    update_opportunity: Permission.WRITE,
    query: Permission.READ,
    create_task: Permission.WRITE,
    get_account: Permission.READ,
    list_opportunities: Permission.READ,
  },
});
