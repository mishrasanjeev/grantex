from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="sendgrid",
    description="SendGrid Email API",
    tools={
        "send_email": Permission.WRITE,
        "create_template": Permission.WRITE,
        "get_stats": Permission.READ,
        "get_bounces": Permission.READ,
        "validate_email": Permission.READ,
        "send_email_with_tracking": Permission.WRITE,
        "get_email_activity": Permission.READ,
    },
)
