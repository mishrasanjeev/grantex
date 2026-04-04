from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="netsuite",
    description="NetSuite ERP API",
    tools={
        "create_invoice": Permission.WRITE,
        "get_invoice": Permission.READ,
        "create_journal_entry": Permission.WRITE,
        "get_account_balance": Permission.READ,
        "create_vendor_bill": Permission.WRITE,
        "create_purchase_order": Permission.WRITE,
        "get_trial_balance": Permission.READ,
        "search_records": Permission.READ,
    },
)
