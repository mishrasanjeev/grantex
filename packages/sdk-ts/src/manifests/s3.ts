import { ToolManifest, Permission } from '../manifest.js';

export const s3Manifest = new ToolManifest({
  connector: 's3',
  description: 'Amazon S3 API',
  tools: {
    upload_document: Permission.WRITE,
    download_document: Permission.READ,
    list_objects: Permission.READ,
    generate_signed_url: Permission.READ,
    delete_object: Permission.DELETE,
    copy_object: Permission.WRITE,
  },
});
