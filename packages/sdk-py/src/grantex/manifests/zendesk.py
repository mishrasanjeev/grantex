from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="zendesk",
    description="Zendesk Support API",
    tools={
        "create_ticket": Permission.WRITE,
        "update_ticket": Permission.WRITE,
        "get_ticket": Permission.READ,
        "apply_macro": Permission.WRITE,
        "get_csat_score": Permission.READ,
        "escalate_ticket": Permission.WRITE,
        "merge_tickets": Permission.WRITE,
        "get_sla_status": Permission.READ,
    },
)
