import { ToolManifest, Permission } from '../manifest.js';

export const brandwatchManifest = new ToolManifest({
  connector: 'brandwatch',
  description: 'Brandwatch Social Listening API',
  tools: {
    get_mentions: Permission.READ,
    get_mention_summary: Permission.READ,
    get_share_of_voice: Permission.READ,
    create_alert: Permission.WRITE,
    export_report: Permission.READ,
  },
});
