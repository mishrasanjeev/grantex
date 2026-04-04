import { ToolManifest, Permission } from '../manifest.js';

export const sanctionsApiManifest = new ToolManifest({
  connector: 'sanctions_api',
  description: 'Sanctions Screening API',
  tools: {
    screen_entity: Permission.READ,
    screen_transaction: Permission.READ,
    get_alert: Permission.READ,
    batch_screen: Permission.READ,
    generate_report: Permission.READ,
  },
});
