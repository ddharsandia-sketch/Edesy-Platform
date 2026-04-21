"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLAN_LIMITS = void 0;
exports.billingRoutes = billingRoutes;
const prisma_1 = require("../lib/prisma");
const paypal_1 = require("../lib/paypal");
const auth_1 = require("../middleware/auth");
// Plan limits — enforced on every call start
exports.PLAN_LIMITS = {
    free: {
        minutesPerMonth: 100,
        agentsMax: 1,
        callsPerMonth: 50,
        label: 'Free',
        price: 0,
    },
    starter: {
        minutesPerMonth: 2000,
        agentsMax: 3,
        callsPerMonth: 1000,
        label: 'Starter',
        price: 49,
    },
    growth: {
        minutesPerMonth: 10000,
        agentsMax: 10,
        callsPerMonth: 5000,
        label: 'Growth',
        price: 149,
    },
    enterprise: {
        minutesPerMonth: 999999, // Unlimited
        agentsMax: 999,
        callsPerMonth: 999999,
        label: 'Enterprise',
        price: 499,
    },
};
async function billingRoutes(app) {
    /**
     * GET /billing/plans
     * Returns all available plans (public — no auth required).
     * Used for the pricing page.
     */
    app.get('/billing/plans', async (request, reply) => {
        return reply.send(Object.entries(exports.PLAN_LIMITS).map(([tier, config]) => ({
            tier,
            ...config,
            planId: process.env[`PAYPAL_${tier.toUpperCase()}_PLAN_ID`] ?? null,
        })));
    });
    /**
     * GET /billing/subscription
     * Returns the current workspace's subscription status.
     */
    app.get('/billing/subscription', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const workspace = await prisma_1.prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: {
                paypalPayerId: true,
                paypalSubscriptionId: true,
                planTier: true,
                planExpiresAt: true,
            }
        });
        if (!workspace)
            return reply.code(404).send({ error: 'Workspace not found' });
        // Get current month usage
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);
        const usage = await prisma_1.prisma.call.aggregate({
            where: {
                workspaceId,
                startTime: { gte: startOfMonth },
                status: 'completed',
            },
            _sum: { duration: true }
        });
        const minutesUsed = Math.ceil((usage._sum.duration || 0) / 60);
        const limits = exports.PLAN_LIMITS[workspace.planTier] || exports.PLAN_LIMITS.free;
        return reply.send({
            tier: workspace.planTier || 'free',
            limits,
            usage: {
                minutesUsed,
                minutesRemaining: Math.max(0, limits.minutesPerMonth - minutesUsed),
                pctUsed: Math.round((minutesUsed / limits.minutesPerMonth) * 100),
            },
            paypalSubscriptionId: workspace.paypalSubscriptionId,
        });
    });
    /**
     * POST /billing/checkout
     * Create a PayPal Subscription request.
     * Returns approval URL and subscription ID.
     *
     * Body: { tier: "starter" | "growth" | "enterprise" }
     */
    app.post('/billing/checkout', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { tier } = request.body;
        if (!['starter', 'growth', 'enterprise'].includes(tier)) {
            return reply.code(400).send({ error: 'Invalid tier. Must be: starter, growth, or enterprise' });
        }
        const planId = process.env[`PAYPAL_${tier.toUpperCase()}_PLAN_ID`];
        if (!planId)
            return reply.code(500).send({ error: `PayPal Plan ID for ${tier} not configured` });
        try {
            const subscription = await (0, paypal_1.createSubscription)(planId, workspaceId);
            // Get the approval link from the response
            const approvalUrl = subscription.links?.find((l) => l.rel === 'approve')?.href;
            return reply.send({
                checkoutUrl: approvalUrl,
                subscriptionId: subscription.id
            });
        }
        catch (err) {
            return reply.code(500).send({ error: err.message });
        }
    });
    /**
     * POST /billing/portal
     * For PayPal, there is no generic "billing portal" session like Stripe.
     * We redirect users to their PayPal account subscriptions page.
     */
    app.post('/billing/portal', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        // PayPal Subscriptions are managed directly in the user's PayPal account
        return reply.send({
            portalUrl: 'https://www.paypal.com/myaccount/autopay/'
        });
    });
}
