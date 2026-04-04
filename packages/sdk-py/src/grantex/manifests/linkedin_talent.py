from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="linkedin_talent",
    description="LinkedIn Talent Solutions API",
    tools={
        "post_job": Permission.WRITE,
        "search_candidates": Permission.READ,
        "send_inmail": Permission.WRITE,
        "get_applicants": Permission.READ,
        "get_analytics": Permission.READ,
        "get_job_insights": Permission.READ,
    },
)
