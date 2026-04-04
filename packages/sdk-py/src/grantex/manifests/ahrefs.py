from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="ahrefs",
    description="Ahrefs SEO API",
    tools={
        "get_domain_rating": Permission.READ,
        "get_backlinks": Permission.READ,
        "get_organic_keywords": Permission.READ,
        "get_content_gap": Permission.READ,
        "get_site_audit": Permission.READ,
    },
)
