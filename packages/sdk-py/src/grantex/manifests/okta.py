from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="okta",
    description="Okta Identity Management API",
    tools={
        "provision_user": Permission.WRITE,
        "deactivate_user": Permission.DELETE,
        "assign_group": Permission.WRITE,
        "remove_group": Permission.DELETE,
        "get_access_log": Permission.READ,
        "reset_mfa": Permission.ADMIN,
        "list_active_sessions": Permission.READ,
        "suspend_user": Permission.DELETE,
    },
)
