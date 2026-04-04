import { ToolManifest, Permission } from '../manifest.js';

export const bomboraManifest = new ToolManifest({
  connector: 'bombora',
  description: 'Bombora Intent Data API',
  tools: {
    get_surge_scores: Permission.READ,
    get_topic_clusters: Permission.READ,
    get_weekly_report: Permission.READ,
    search_companies: Permission.READ,
  },
});
