import { ToolManifest, Permission } from '../manifest.js';

export const twilioManifest = new ToolManifest({
  connector: 'twilio',
  description: 'Twilio Communications API',
  tools: {
    send_sms: Permission.WRITE,
    make_call: Permission.WRITE,
    send_whatsapp: Permission.WRITE,
    get_recordings: Permission.READ,
    get_message_status: Permission.READ,
  },
});
