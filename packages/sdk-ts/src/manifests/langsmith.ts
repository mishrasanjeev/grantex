import { ToolManifest, Permission } from '../manifest.js';

export const langsmithManifest = new ToolManifest({
  connector: 'langsmith',
  description: 'LangSmith Observability API',
  tools: {
    list_runs: Permission.READ,
    get_run: Permission.READ,
    get_run_stats: Permission.READ,
    list_datasets: Permission.READ,
    create_feedback: Permission.WRITE,
  },
});
