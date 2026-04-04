from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="tally",
    description="Tally ERP API",
    tools={
        "post_voucher": Permission.WRITE,
        "get_ledger_balance": Permission.READ,
        "generate_gst_report": Permission.READ,
        "export_tally_xml_data": Permission.READ,
        "get_trial_balance": Permission.READ,
        "get_stock_summary": Permission.READ,
    },
)
