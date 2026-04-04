from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="slack",
    description="Slack Web API",
    tools={
        "send_message": Permission.WRITE,
        "create_channel": Permission.WRITE,
        "upload_file": Permission.WRITE,
        "search_messages": Permission.READ,
        "list_channels": Permission.READ,
        "set_reminder": Permission.WRITE,
        "post_alert": Permission.WRITE,
    },
)
