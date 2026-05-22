import { createRequire } from "node:module";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface StripeConfig {
  /** Stripe secret API key. Falls back to STRIPE_SECRET_KEY env var. */
  secretKey?: string;
  /** Max items per list operation (default 25). */
  maxItems?: number;
}

/**
 * Stripe Toolkit — list charges, get customers, create refunds, list subscriptions, get invoices.
 *
 * Requires the `stripe` peer dependency.
 *
 * @example
 * ```ts
 * const stripe = new StripeToolkit({ secretKey: process.env.STRIPE_SECRET_KEY });
 * const agent = new Agent({ tools: [...stripe.getTools()] });
 * ```
 */
export class StripeToolkit extends Toolkit {
  readonly name = "stripe";
  private secretKey: string;
  private maxItems: number;
  private stripeClient: any;

  constructor(config: StripeConfig = {}) {
    super();
    this.secretKey = config.secretKey ?? process.env.STRIPE_SECRET_KEY ?? "";
    this.maxItems = config.maxItems ?? 25;
    if (!this.secretKey) throw new Error("Stripe secret key is required. Set secretKey or STRIPE_SECRET_KEY env var.");
  }

  private getStripe(): any {
    if (this.stripeClient) return this.stripeClient;
    const Stripe = _require("stripe");
    this.stripeClient = new Stripe(this.secretKey);
    return this.stripeClient;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "stripe_list_charges",
        description: "List recent charges.",
        parameters: z.object({
          limit: z.number().optional().describe("Max charges to return (default 25)"),
          customer: z.string().optional().describe("Filter by customer ID"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const stripe = this.getStripe();
            const params: any = { limit: (args.limit as number) ?? this.maxItems };
            if (args.customer) params.customer = args.customer;
            const charges = await stripe.charges.list(params);
            const result = charges.data.map((c: any) => ({
              id: c.id,
              amount: c.amount / 100,
              currency: c.currency,
              status: c.status,
              customer: c.customer,
              description: c.description,
              created: new Date(c.created * 1000).toISOString(),
            }));
            return JSON.stringify(result, null, 2);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "stripe_get_customer",
        description: "Get details of a Stripe customer.",
        parameters: z.object({
          customerId: z.string().describe("Stripe customer ID (cus_...)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const stripe = this.getStripe();
            const customer = await stripe.customers.retrieve(args.customerId as string);
            return JSON.stringify(
              {
                id: customer.id,
                email: customer.email,
                name: customer.name,
                phone: customer.phone,
                balance: customer.balance / 100,
                currency: customer.currency,
                created: new Date(customer.created * 1000).toISOString(),
                metadata: customer.metadata,
              },
              null,
              2,
            );
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "stripe_create_refund",
        description: "Create a refund for a charge.",
        parameters: z.object({
          chargeId: z.string().describe("Charge ID to refund (ch_...)"),
          amount: z.number().optional().describe("Refund amount in dollars (omit for full refund)"),
          reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).optional().describe("Refund reason"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const stripe = this.getStripe();
            const params: any = { charge: args.chargeId };
            if (args.amount) params.amount = Math.round((args.amount as number) * 100);
            if (args.reason) params.reason = args.reason;
            const refund = await stripe.refunds.create(params);
            return JSON.stringify(
              {
                id: refund.id,
                amount: refund.amount / 100,
                currency: refund.currency,
                status: refund.status,
                charge: refund.charge,
              },
              null,
              2,
            );
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "stripe_list_subscriptions",
        description: "List subscriptions, optionally filtered by customer.",
        parameters: z.object({
          customer: z.string().optional().describe("Filter by customer ID"),
          status: z
            .enum(["active", "past_due", "canceled", "all"])
            .optional()
            .describe("Filter by status (default all)"),
          limit: z.number().optional().describe("Max results (default 25)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const stripe = this.getStripe();
            const params: any = { limit: (args.limit as number) ?? this.maxItems };
            if (args.customer) params.customer = args.customer;
            if (args.status && args.status !== "all") params.status = args.status;
            const subs = await stripe.subscriptions.list(params);
            const result = subs.data.map((s: any) => ({
              id: s.id,
              status: s.status,
              customer: s.customer,
              currentPeriodEnd: new Date(s.current_period_end * 1000).toISOString(),
              plan: s.items?.data?.[0]?.price?.nickname ?? s.items?.data?.[0]?.price?.id,
              amount: (s.items?.data?.[0]?.price?.unit_amount ?? 0) / 100,
              currency: s.items?.data?.[0]?.price?.currency,
            }));
            return JSON.stringify(result, null, 2);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "stripe_get_invoice",
        description: "Get details of a Stripe invoice.",
        parameters: z.object({
          invoiceId: z.string().describe("Invoice ID (in_...)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const stripe = this.getStripe();
            const invoice = await stripe.invoices.retrieve(args.invoiceId as string);
            return JSON.stringify(
              {
                id: invoice.id,
                status: invoice.status,
                customer: invoice.customer,
                amountDue: invoice.amount_due / 100,
                amountPaid: invoice.amount_paid / 100,
                currency: invoice.currency,
                dueDate: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString() : null,
                hostedUrl: invoice.hosted_invoice_url,
                pdf: invoice.invoice_pdf,
                created: new Date(invoice.created * 1000).toISOString(),
              },
              null,
              2,
            );
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
