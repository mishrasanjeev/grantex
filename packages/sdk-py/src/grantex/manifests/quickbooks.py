from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="quickbooks",
    description="QuickBooks Online API",
    tools={
        "create_invoice": Permission.WRITE,
        "record_payment": Permission.WRITE,
        "get_profit_loss": Permission.READ,
        "get_balance_sheet": Permission.READ,
        "query": Permission.READ,
        "get_company_info": Permission.READ,
    },
)
