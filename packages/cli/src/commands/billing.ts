import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printRecord } from '../format.js';

export function billingCommand(): Command {
  const cmd = new Command('billing').description('Manage subscription and billing');

  cmd
    .command('status')
    .description('Show current subscription status')
    .action(async () => {
      const client = await requireClient();
      const sub = await client.billing.getSubscription();
      printRecord({
        plan: sub.plan,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd ?? '—',
      });
    });

  cmd
    .command('checkout <plan>')
    .description('Create a checkout session for a plan (pro or enterprise)')
    .requiredOption('--success-url <url>', 'Redirect URL after successful payment')
    .requiredOption('--cancel-url <url>', 'Redirect URL if user cancels')
    .action(async (plan: string, opts: { successUrl: string; cancelUrl: string }) => {
      const client = await requireClient();
      const { checkoutUrl } = await client.billing.createCheckout({
        plan: plan as 'pro' | 'enterprise',
        successUrl: opts.successUrl,
        cancelUrl: opts.cancelUrl,
      });
      console.log(chalk.green('✓') + ' Checkout URL:');
      console.log(checkoutUrl);
    });

  cmd
    .command('portal')
    .description('Create a billing portal session')
    .requiredOption('--return-url <url>', 'URL to return to after portal session')
    .action(async (opts: { returnUrl: string }) => {
      const client = await requireClient();
      const { portalUrl } = await client.billing.createPortal({ returnUrl: opts.returnUrl });
      console.log(chalk.green('✓') + ' Portal URL:');
      console.log(portalUrl);
    });

  return cmd;
}
