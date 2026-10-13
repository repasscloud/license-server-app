/** @jsxImportSource hono/jsx */
import { Csrf } from './layout.tsx';
export const BillingAction = ({ customerId, csrf }: { customerId: string; csrf: string }) => <div class="billing-actions">
  <form method="post" action={`/portal/customers/${customerId}/billing`}><Csrf token={csrf} /><button class="billing-button" type="submit">Manage billing <img class="stripe-button-logo" src="/assets/stripe.svg" alt="Stripe" width="50" height="21" /></button></form>
</div>;
