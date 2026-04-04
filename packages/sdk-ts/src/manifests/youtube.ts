import { ToolManifest, Permission } from '../manifest.js';

export const youtubeManifest = new ToolManifest({
  connector: 'youtube',
  description: 'YouTube Data API v3',
  tools: {
    list_videos: Permission.READ,
    get_video_stats: Permission.READ,
    list_channel_videos: Permission.READ,
    get_channel_stats: Permission.READ,
    list_playlists: Permission.READ,
    get_video_analytics: Permission.READ,
  },
});
