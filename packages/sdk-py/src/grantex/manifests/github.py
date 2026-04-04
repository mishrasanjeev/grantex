from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="github",
    description="GitHub REST API",
    tools={
        "list_repos": Permission.READ,
        "get_repo": Permission.READ,
        "list_repository_issues": Permission.READ,
        "create_issue": Permission.WRITE,
        "create_pull_request": Permission.WRITE,
        "get_repository_statistics": Permission.READ,
        "search_code": Permission.READ,
        "create_release": Permission.WRITE,
        "trigger_github_action_workflow": Permission.WRITE,
    },
)
