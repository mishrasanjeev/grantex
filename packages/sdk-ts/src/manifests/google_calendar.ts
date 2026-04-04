import { ToolManifest, Permission } from '../manifest.js';

export const googleCalendarManifest = new ToolManifest({
  connector: 'google_calendar',
  description: 'Google Calendar API',
  tools: {
    create_event: Permission.WRITE,
    list_events: Permission.READ,
    check_availability: Permission.READ,
    delete_event: Permission.DELETE,
    find_free_slot: Permission.READ,
  },
});
