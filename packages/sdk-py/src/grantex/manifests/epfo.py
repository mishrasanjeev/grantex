from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="epfo",
    description="EPFO (Employees Provident Fund Organisation) API",
    tools={
        "file_ecr": Permission.WRITE,
        "get_uan": Permission.READ,
        "check_claim_status": Permission.READ,
        "download_passbook": Permission.READ,
        "generate_trrn": Permission.WRITE,
        "verify_member": Permission.READ,
    },
)
