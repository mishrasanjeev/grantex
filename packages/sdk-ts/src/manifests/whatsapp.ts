import { ToolManifest, Permission } from '../manifest.js';

export const whatsappManifest = new ToolManifest({
  connector: 'whatsapp',
  description: 'WhatsApp Business API',
  tools: {
    send_template_message: Permission.WRITE,
    send_text_message: Permission.WRITE,
    send_media_message: Permission.WRITE,
    get_message_templates: Permission.READ,
    get_business_profile: Permission.READ,
  },
});
