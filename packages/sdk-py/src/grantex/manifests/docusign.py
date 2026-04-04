from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="docusign",
    description="DocuSign eSignature API",
    tools={
        "send_envelope": Permission.WRITE,
        "get_envelope_status": Permission.READ,
        "void_envelope": Permission.DELETE,
        "download_document": Permission.READ,
        "list_templates": Permission.READ,
        "create_envelope_from_template": Permission.WRITE,
    },
)
