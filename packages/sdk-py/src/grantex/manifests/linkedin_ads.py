from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="linkedin_ads",
    description="LinkedIn Ads API",
    tools={
        "create_campaign": Permission.WRITE,
        "get_analytics": Permission.READ,
        "create_lead_gen_form": Permission.WRITE,
        "get_targeting_criteria": Permission.READ,
    },
)
