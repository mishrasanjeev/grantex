import { ToolManifest, Permission } from '../manifest.js';

export const gmailManifest = new ToolManifest({
  connector: 'gmail',
  description: 'Gmail API',
  tools: {
    send_email: Permission.WRITE,
    read_inbox: Permission.READ,
    search_emails: Permission.READ,
    get_thread: Permission.READ,
  },
});
