from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="pagerduty",
    description="PagerDuty Incident Management API",
    tools={
        "create_incident": Permission.WRITE,
        "acknowledge_incident": Permission.WRITE,
        "resolve_incident": Permission.WRITE,
        "get_on_call": Permission.READ,
        "list_incidents": Permission.READ,
        "create_postmortem": Permission.WRITE,
    },
)
