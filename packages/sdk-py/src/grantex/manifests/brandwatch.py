from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="brandwatch",
    description="Brandwatch Social Listening API",
    tools={
        "get_mentions": Permission.READ,
        "get_mention_summary": Permission.READ,
        "get_share_of_voice": Permission.READ,
        "create_alert": Permission.WRITE,
        "export_report": Permission.READ,
    },
)
