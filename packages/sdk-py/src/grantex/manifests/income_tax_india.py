from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="income_tax_india",
    description="Income Tax India e-Filing API",
    tools={
        "file_26q_return": Permission.WRITE,
        "file_24q_return": Permission.WRITE,
        "check_tds_credit_in_26as": Permission.READ,
        "download_form_16a": Permission.READ,
        "file_itr": Permission.WRITE,
        "get_compliance_notice": Permission.READ,
        "pay_tax_challan": Permission.WRITE,
    },
)
