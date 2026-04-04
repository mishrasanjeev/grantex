from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="sanctions_api",
    description="Sanctions Screening API",
    tools={
        "screen_entity": Permission.READ,
        "screen_transaction": Permission.READ,
        "get_alert": Permission.READ,
        "batch_screen": Permission.READ,
        "generate_report": Permission.READ,
    },
)
