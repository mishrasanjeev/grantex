from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="mixpanel",
    description="Mixpanel Analytics API",
    tools={
        "get_funnel": Permission.READ,
        "get_retention": Permission.READ,
        "query_jql": Permission.READ,
        "get_segmentation": Permission.READ,
        "export_events": Permission.READ,
    },
)
