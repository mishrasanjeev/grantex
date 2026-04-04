from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="darwinbox",
    description="Darwinbox HRMS API",
    tools={
        "get_employee": Permission.READ,
        "create_employee": Permission.WRITE,
        "run_payroll": Permission.ADMIN,
        "get_attendance": Permission.READ,
        "apply_leave": Permission.WRITE,
        "get_org_chart": Permission.READ,
        "update_performance": Permission.WRITE,
        "terminate_employee": Permission.DELETE,
        "transfer_employee": Permission.WRITE,
        "get_payslip": Permission.READ,
    },
)
