import { ToolManifest, Permission } from '../manifest.js';

export const bufferManifest = new ToolManifest({
  connector: 'buffer',
  description: 'Buffer Social Media Management API',
  tools: {
    create_update: Permission.WRITE,
    get_update_analytics: Permission.READ,
    get_pending_updates: Permission.READ,
    list_profiles: Permission.READ,
    move_to_top: Permission.WRITE,
  },
});
