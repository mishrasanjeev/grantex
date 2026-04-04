from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="trustradius",
    description="TrustRadius Buyer Intent API",
    tools={
        "get_buyer_intent": Permission.READ,
        "get_product_reviews": Permission.READ,
        "get_comparison_traffic": Permission.READ,
        "search_vendors": Permission.READ,
    },
)
