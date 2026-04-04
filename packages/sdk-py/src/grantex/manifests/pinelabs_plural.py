from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="pinelabs_plural",
    description="Pine Labs Plural Payments API",
    tools={
        "create_order": Permission.WRITE,
        "check_order_status": Permission.READ,
        "create_payment_link": Permission.WRITE,
        "initiate_refund": Permission.WRITE,
        "get_settlement_report": Permission.READ,
        "get_payout_analytics": Permission.READ,
    },
)
