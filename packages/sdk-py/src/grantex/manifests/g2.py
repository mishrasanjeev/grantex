from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="g2",
    description="G2 Buyer Intent API",
    tools={
        "get_intent_signals": Permission.READ,
        "get_product_reviews": Permission.READ,
        "get_comparison_data": Permission.READ,
        "get_category_leaders": Permission.READ,
    },
)
