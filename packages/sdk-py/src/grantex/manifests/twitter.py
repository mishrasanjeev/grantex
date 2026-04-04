from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="twitter",
    description="Twitter/X API v2",
    tools={
        "create_tweet": Permission.WRITE,
        "get_tweet": Permission.READ,
        "search_recent": Permission.READ,
        "get_user_tweets": Permission.READ,
        "get_user_by_username": Permission.READ,
        "get_tweet_metrics": Permission.READ,
    },
)
