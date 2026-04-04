import { ToolManifest, Permission } from '../manifest.js';

export const sapManifest = new ToolManifest({
  connector: 'sap',
  description: 'SAP S/4HANA API',
  tools: {
    post_journal_entry: Permission.WRITE,
    get_gl_balance: Permission.READ,
    create_purchase_order: Permission.WRITE,
    post_goods_receipt: Permission.WRITE,
    run_payment_run: Permission.ADMIN,
    get_vendor_master: Permission.READ,
    get_cost_center: Permission.READ,
  },
});
