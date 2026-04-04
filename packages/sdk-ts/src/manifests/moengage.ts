import { ToolManifest, Permission } from '../manifest.js';

export const moengageManifest = new ToolManifest({
  connector: 'moengage',
  description: 'MoEngage Customer Engagement API',
  tools: {
    create_campaign: Permission.WRITE,
    get_campaign_stats: Permission.READ,
    create_segment: Permission.WRITE,
    send_push_notification: Permission.WRITE,
    get_user_profile: Permission.READ,
    track_event: Permission.WRITE,
  },
});
