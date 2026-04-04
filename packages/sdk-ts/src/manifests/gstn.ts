import { ToolManifest, Permission } from '../manifest.js';

export const gstnManifest = new ToolManifest({
  connector: 'gstn',
  description: 'GST Network API',
  tools: {
    fetch_gstr2a: Permission.READ,
    push_gstr1_data: Permission.WRITE,
    file_gstr3b: Permission.WRITE,
    file_gstr9: Permission.WRITE,
    generate_eway_bill: Permission.WRITE,
    generate_einvoice_irn: Permission.WRITE,
    check_filing_status: Permission.READ,
    get_compliance_notice: Permission.READ,
  },
});
