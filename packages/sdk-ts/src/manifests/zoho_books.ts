import { ToolManifest, Permission } from '../manifest.js';

export const zohoBooksManifest = new ToolManifest({
  connector: 'zoho_books',
  description: 'Zoho Books API',
  tools: {
    create_invoice: Permission.WRITE,
    list_invoices: Permission.READ,
    record_expense: Permission.WRITE,
    get_balance_sheet: Permission.READ,
    get_profit_loss: Permission.READ,
    list_chartofaccounts: Permission.READ,
    reconcile_transaction: Permission.WRITE,
  },
});
