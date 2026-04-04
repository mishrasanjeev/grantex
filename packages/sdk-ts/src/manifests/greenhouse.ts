import { ToolManifest, Permission } from '../manifest.js';

export const greenhouseManifest = new ToolManifest({
  connector: 'greenhouse',
  description: 'Greenhouse Recruiting API',
  tools: {
    list_jobs: Permission.READ,
    get_candidate: Permission.READ,
    list_applications: Permission.READ,
    schedule_interview: Permission.WRITE,
    create_candidate: Permission.WRITE,
    advance_application: Permission.WRITE,
    reject_application: Permission.DELETE,
    get_scorecards: Permission.READ,
  },
});
