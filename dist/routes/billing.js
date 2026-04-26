"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLAN_LIMITS = void 0;
exports.billingRoutes = billingRoutes;
const stripe_1 = __importDefault(require("stripe"));
const prisma_1 = require("../lib/prisma");
const auth_1 = require("../middleware/auth");
const stripe = new stripe_1.default(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-04-22.dahlia',
});
exports.PLAN_LIMITS = {
    free: { minutesPerMonth: 100, agentsMax: 1, callsPerMonth: 50, label: 'Free', price: 0 },
    starter: { minutesPerMonth: 2000, agentsMax: 3, callsPerMonth: 1000, label: 'Starter', price: 49 },
    growth: { minutesPerMonth: 10000, agentsMax: 10, callsPerMonth: 5000, label: 'Growth', price: 149 },
    professional: { minutesPerMonth: 10000, agentsMax: 10, callsPerMonth: 5000, label: 'Professional', price: 149 },
    enterprise: { minutesPerMonth: 999999, agentsMax: 999, callsPerMonth: 999999, label: 'Enterprise', price: 499 },
};
const PRICE_MAP = {
    starter: process.env.STRIPE_PRICE_ID_STARTER,
    growth: process.env.STRIPE_PRICE_ID_GROWTH,
    professional: process.env.STRIPE_PRICE_ID_GROWTH, // alias
    enterprise: process.env.STRIPE_PRICE_ID_ENTERPRISE,
};
async function billingRoutes(app) {
    // ── GET /billing/plans — public ───────────────────────────────────────────
    app.get('/billing/plans', async (_req, reply) => {
        return reply.send(Object.entries(exports.PLAN_LIMITS).map(([tier, cfg]) => ({ tier, ...cfg })));
    });
    // ── GET /billing/subscription — current plan + usage ─────────────────────
    app.get('/billing/subscription', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        try {
            const { workspaceId } = request.user;
            const workspace = await prisma_1.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { planTier: true, plan: true, planExpiresAt: true, stripeSubscriptionId: true },
            });
            if (!workspace)
                return reply.code(404).send({ error: 'Workspace not found' });
            const startOfMonth = new Date();
            startOfMonth.setDate(1);
            startOfMonth.setHours(0, 0, 0, 0);
            const usage = await prisma_1.prisma.call.aggregate({
                where: { workspaceId, startTime: { gte: startOfMonth }, status: 'completed' },
                _sum: { duration: true },
            });
            const minutesUsed = Math.ceil((usage._sum.duration || 0) / 60);
            const tier = (workspace.planTier || workspace.plan || 'free');
            const limits = exports.PLAN_LIMITS[tier] ?? exports.PLAN_LIMITS.free;
            return reply.send({
                tier,
                limits,
                usage: {
                    minutesUsed,
                    minutesRemaining: Math.max(0, limits.minutesPerMonth - minutesUsed),
                    pctUsed: Math.min(100, Math.round((minutesUsed / limits.minutesPerMonth) * 100)),
                },
            });
        }
        catch (err) {
            console.error('[billing/subscription]', err.message);
            return reply.code(500).send({ error: err.message });
        }
    });
    // ── POST /billing/checkout — Stripe Checkout session (card, no PayPal) ────
    app.post('/billing/checkout', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        try {
            const { workspaceId } = request.user;
            // Accept both "tier" (new) and "plan" (legacy) field names
            const body = request.body;
            const tier = body.tier ?? body.plan ?? '';
            if (!['starter', 'growth', 'professional', 'enterprise'].includes(tier)) {
                return reply.code(400).send({ error: `Invalid plan tier: ${tier}` });
            }
            const priceId = PRICE_MAP[tier];
            if (!priceId) {
                return reply.code(500).send({ error: `Stripe price not configured for '${tier}'. Add STRIPE_PRICE_ID_${tier.toUpperCase()} to env.` });
            }
            const workspace = await prisma_1.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { id: true, name: true, stripeCustomerId: true },
            });
            if (!workspace)
                return reply.code(404).send({ error: 'Workspace not found' });
            let customerId = workspace.stripeCustomerId;
            if (!customerId) {
                const customer = await stripe.customers.create({ name: workspace.name, metadata: { workspaceId } });
                customerId = customer.id;
                await prisma_1.prisma.workspace.update({ where: { id: workspaceId }, data: { stripeCustomerId: customerId } });
            }
            const session = await stripe.checkout.sessions.create({
                customer: customerId,
                mode: 'subscription',
                line_items: [{ price: priceId, quantity: 1 }],
                payment_method_collection: 'always',
                success_url: `${process.env.FRONTEND_URL}/dashboard/settings?billing=success&plan=${tier}`,
                cancel_url: `${process.env.FRONTEND_URL}/dashboard/settings?billing=cancelled`,
                metadata: { workspaceId, tier, plan: tier },
            });
            // Return BOTH field names for forward + backward compat
            return reply.send({ checkoutUrl: session.url, url: session.url });
        }
        catch (err) {
            console.error('[billing/checkout]', err.message);
            return reply.code(500).send({ error: err.message });
        }
    });
    // ── POST /billing/portal — manage existing subscription ───────────────────
    app.post('/billing/portal', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        try {
            const { workspaceId } = request.user;
            const workspace = await prisma_1.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { stripeCustomerId: true },
            });
            if (!workspace?.stripeCustomerId) {
                return reply.code(400).send({ error: 'No billing account found. Subscribe first.' });
            }
            const portal = await stripe.billingPortal.sessions.create({
                customer: workspace.stripeCustomerId,
                return_url: `${process.env.FRONTEND_URL}/dashboard/settings`,
            });
            // Return both field names for compat
            return reply.send({ portalUrl: portal.url, url: portal.url });
        }
        catch (err) {
            console.error('[billing/portal]', err.message);
            return reply.code(500).send({ error: err.message });
        }
    });
    // ── POST /billing/webhook — Stripe events ────────────────────────────────
    app.post('/billing/webhook', async (request, reply) => {
        const sig = request.headers['stripe-signature'];
        const body = request.rawBody ?? JSON.stringify(request.body);
        let event;
        try {
            event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        }
        catch (err) {
            return reply.code(400).send({ error: `Webhook error: ${err.message}` });
        }
        if (event.type === 'checkout.session.completed') {
            const s = event.data.object;
            const workspaceId = s.metadata?.workspaceId;
            const tier = s.metadata?.tier ?? s.metadata?.plan;
            if (workspaceId && tier) {
                await prisma_1.prisma.workspace.update({
                    where: { id: workspaceId },
                    data: { planTier: tier, plan: tier, stripeSubscriptionId: s.subscription },
                });
            }
        }
        if (event.type === 'customer.subscription.deleted') {
            const sub = event.data.object;
            await prisma_1.prisma.workspace.updateMany({
                where: { stripeSubscriptionId: sub.id },
                data: { planTier: 'free', plan: 'free' },
            });
        }
        return reply.send({ received: true });
    });
}
