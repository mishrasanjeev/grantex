from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="stripe",
    description="Stripe Payments API",
    tools={
        "create_payment_intent": Permission.WRITE,
        "list_charges": Permission.READ,
        "create_payout": Permission.WRITE,
        "get_balance": Permission.READ,
        "list_invoices": Permission.READ,
        "create_customer": Permission.WRITE,
        "list_disputes": Permission.READ,
        "create_refund": Permission.WRITE,
    },
)
