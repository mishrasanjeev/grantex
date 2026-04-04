from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="jira",
    description="Jira Software REST API",
    tools={
        "list_projects": Permission.READ,
        "get_project": Permission.READ,
        "search_issues": Permission.READ,
        "get_issue": Permission.READ,
        "create_issue": Permission.WRITE,
        "update_issue": Permission.WRITE,
        "transition_issue": Permission.WRITE,
        "get_transitions": Permission.READ,
        "add_comment": Permission.WRITE,
        "get_sprint_data": Permission.READ,
        "get_project_metrics": Permission.READ,
    },
)
