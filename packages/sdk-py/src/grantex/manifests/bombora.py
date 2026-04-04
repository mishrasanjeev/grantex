from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="bombora",
    description="Bombora Intent Data API",
    tools={
        "get_surge_scores": Permission.READ,
        "get_topic_clusters": Permission.READ,
        "get_weekly_report": Permission.READ,
        "search_companies": Permission.READ,
    },
)
