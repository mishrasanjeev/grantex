import { ToolManifest, Permission } from '../manifest.js';

export const hubspotManifest = new ToolManifest({
  connector: 'hubspot',
  description: 'HubSpot CRM API',
  tools: {
    list_contacts: Permission.READ,
    search_contacts: Permission.READ,
    create_contact: Permission.WRITE,
    get_contact: Permission.READ,
    update_contact: Permission.WRITE,
    list_deals: Permission.READ,
    create_deal: Permission.WRITE,
    get_deal: Permission.READ,
    update_deal: Permission.WRITE,
    list_pipelines: Permission.READ,
    list_companies: Permission.READ,
    create_company: Permission.WRITE,
    get_campaign_analytics: Permission.READ,
  },
});
