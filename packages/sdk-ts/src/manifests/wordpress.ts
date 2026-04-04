import { ToolManifest, Permission } from '../manifest.js';

export const wordpressManifest = new ToolManifest({
  connector: 'wordpress',
  description: 'WordPress REST API',
  tools: {
    create_post: Permission.WRITE,
    update_post: Permission.WRITE,
    list_posts: Permission.READ,
    get_post: Permission.READ,
    upload_media: Permission.WRITE,
    list_categories: Permission.READ,
    create_page: Permission.WRITE,
  },
});
