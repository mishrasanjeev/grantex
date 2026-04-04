import { ToolManifest, Permission } from '../manifest.js';

export const metaAdsManifest = new ToolManifest({
  connector: 'meta_ads',
  description: 'Meta Ads (Facebook/Instagram) API',
  tools: {
    get_campaign_insights: Permission.READ,
    update_campaign_budget: Permission.WRITE,
    create_custom_audience: Permission.WRITE,
    update_adset_status: Permission.WRITE,
    get_ad_account_info: Permission.READ,
  },
});
