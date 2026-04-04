import { ToolManifest, Permission } from '../manifest.js';

export const kekaManifest = new ToolManifest({
  connector: 'keka',
  description: 'Keka HR API',
  tools: {
    get_employee: Permission.READ,
    list_employees: Permission.READ,
    run_payroll: Permission.ADMIN,
    get_leave_balance: Permission.READ,
    post_reimbursement: Permission.WRITE,
    get_attendance_summary: Permission.READ,
  },
});
