from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="oracle_fusion",
    description="Oracle Fusion Cloud ERP API",
    tools={
        "post_journal_entry": Permission.WRITE,
        "get_gl_balance": Permission.READ,
        "create_ap_invoice": Permission.WRITE,
        "approve_payment": Permission.WRITE,
        "get_budget": Permission.READ,
        "create_po": Permission.WRITE,
        "get_trial_balance": Permission.READ,
        "run_period_close": Permission.ADMIN,
        "get_cash_position": Permission.READ,
        "run_reconciliation": Permission.WRITE,
    },
)
