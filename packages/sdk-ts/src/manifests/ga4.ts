import { ToolManifest, Permission } from '../manifest.js';

export const ga4Manifest = new ToolManifest({
  connector: 'ga4',
  description: 'Google Analytics 4 Data API',
  tools: {
    run_report: Permission.READ,
    run_realtime_report: Permission.READ,
    get_conversions: Permission.READ,
    get_user_acquisition: Permission.READ,
    get_page_analytics: Permission.READ,
    get_metadata: Permission.READ,
  },
});
