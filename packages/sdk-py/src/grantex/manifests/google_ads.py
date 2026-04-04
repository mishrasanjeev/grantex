from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="google_ads",
    description="Google Ads API",
    tools={
        "search_campaigns": Permission.READ,
        "get_campaign_performance": Permission.READ,
        "mutate_campaign_budget": Permission.WRITE,
        "get_search_terms": Permission.READ,
        "create_user_list": Permission.WRITE,
    },
)
