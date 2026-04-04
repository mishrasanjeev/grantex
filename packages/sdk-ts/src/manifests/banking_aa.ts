import { ToolManifest, Permission } from '../manifest.js';

export const bankingAaManifest = new ToolManifest({
  connector: 'banking_aa',
  description: 'Banking Account Aggregator API',
  tools: {
    fetch_bank_statement: Permission.READ,
    check_account_balance: Permission.READ,
    get_transaction_list: Permission.READ,
    request_consent: Permission.WRITE,
    fetch_fi_data: Permission.READ,
  },
});
