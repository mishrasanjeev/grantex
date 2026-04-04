from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="confluence",
    description="Confluence Wiki REST API",
    tools={
        "create_page": Permission.WRITE,
        "update_page": Permission.WRITE,
        "search_content": Permission.READ,
        "get_page": Permission.READ,
        "get_page_tree": Permission.READ,
        "list_spaces": Permission.READ,
    },
)
