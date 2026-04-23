"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const prisma_1 = require("../lib/prisma");
const supabase_js_1 = require("@supabase/supabase-js");
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function requireAuth(request, reply) {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
        return reply.code(401).send({ error: 'No authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    // 1. Try our custom JWT first (used for email/password login)
    try {
        const decoded = await request.jwtVerify();
        if (decoded.workspaceId) {
            return; // Success! request.user is already populated by jwtVerify
        }
    }
    catch (err) {
        // Fall through to Supabase check
    }
    // 2. Try Supabase token (used for Google login)
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        // Find the workspace for this Supabase user
        let workspace = await prisma_1.prisma.workspace.findFirst({
            where: { ownerId: user.id }
        });
        const isFounder = user.email === 'jabir.islam@gau.edu.ge';
        if (!workspace) {
            // Create a default workspace if it doesn't exist (first time OAuth user)
            workspace = await prisma_1.prisma.workspace.create({
                data: {
                    name: isFounder ? 'Founder Workspace' : `${user.email?.split('@')[0]}'s Workspace`,
                    ownerId: user.id,
                    plan: isFounder ? 'enterprise' : 'free',
                    planTier: isFounder ? 'enterprise' : 'free',
                    onboardingComplete: isFounder ? true : false
                }
            });
        }
        else if (isFounder && workspace.plan !== 'enterprise') {
            // Auto-upgrade founder if not already enterprise
            workspace = await prisma_1.prisma.workspace.update({
                where: { id: workspace.id },
                data: { plan: 'enterprise', planTier: 'enterprise', onboardingComplete: true }
            });
        }
        request.user = { userId: user.id, workspaceId: workspace.id, email: user.email, isFounder };
    }
    catch (err) {
        return reply.code(401).send({ error: 'Unauthorized' });
    }
}
