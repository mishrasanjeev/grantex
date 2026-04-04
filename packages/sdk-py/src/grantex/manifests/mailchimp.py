from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="mailchimp",
    description="Mailchimp Email Marketing API",
    tools={
        "list_campaigns": Permission.READ,
        "create_campaign": Permission.WRITE,
        "send_campaign": Permission.WRITE,
        "get_campaign_report": Permission.READ,
        "add_list_member": Permission.WRITE,
        "search_members": Permission.READ,
        "create_template": Permission.WRITE,
        "create_ab_campaign": Permission.WRITE,
        "get_ab_results": Permission.READ,
        "send_winner": Permission.WRITE,
    },
)
