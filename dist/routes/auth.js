"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRoutes = authRoutes;
const crypto_1 = require("crypto");
const prisma_1 = require("../lib/prisma");
const SUPABASE_URL = process.env.SUPABASE_URL || '';
// Local dev mode when Supabase credentials are placeholders
const isLocalDevMode = !SUPABASE_URL || SUPABASE_URL.includes('YOUR_PROJECT') || !SUPABASE_URL.startsWith('https://');
async function authRoutes(app) {
    // POST /auth/register
    app.post('/auth/register', async (request, reply) => {
        const { email, password, workspaceName } = request.body;
        let userId;
        if (isLocalDevMode) {
            // LOCAL DEV: Skip Supabase, generate a UUID as userId
            userId = (0, crypto_1.randomUUID)();
            console.log('[LOCAL DEV] Bypassing Supabase — generated userId:', userId);
        }
        else {
            // PRODUCTION: Create user in Supabase Auth
            const { createClient } = await Promise.resolve().then(() => __importStar(require('@supabase/supabase-js')));
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
            const { data: authData, error: authError } = await supabase.auth.admin.createUser({
                email,
                password,
                email_confirm: true
            });
            if (authError)
                return reply.code(400).send({ error: authError.message });
            userId = authData.user.id;
        }
        // Idempotent: find or create workspace for this user
        const existingWorkspace = await prisma_1.prisma.workspace.findFirst({
            where: { ownerId: userId }
        });
        const workspace = existingWorkspace ??
            (await prisma_1.prisma.workspace.create({
                data: { name: workspaceName, ownerId: userId, plan: 'free' }
            }));
        const token = app.jwt.sign({ userId, workspaceId: workspace.id, email }, { expiresIn: '7d' });
        return reply.send({ token, workspaceId: workspace.id });
    });
    // POST /auth/login
    app.post('/auth/login', async (request, reply) => {
        const { email, password } = request.body;
        if (isLocalDevMode) {
            // LOCAL DEV: Return token for the first existing workspace
            const workspace = await prisma_1.prisma.workspace.findFirst();
            if (!workspace)
                return reply.code(404).send({ error: 'No workspace found. Register first.' });
            const token = app.jwt.sign({ userId: workspace.ownerId, workspaceId: workspace.id, email }, { expiresIn: '7d' });
            return reply.send({ token, workspaceId: workspace.id });
        }
        // PRODUCTION: Verify via Supabase
        const { createClient } = await Promise.resolve().then(() => __importStar(require('@supabase/supabase-js')));
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error)
            return reply.code(401).send({ error: 'Invalid credentials' });
        const workspace = await prisma_1.prisma.workspace.findFirst({ where: { ownerId: data.user.id } });
        if (!workspace)
            return reply.code(404).send({ error: 'Workspace not found' });
        const isFounder = email === 'jabir.islam@gau.edu.ge';
        if (isFounder && workspace.plan !== 'enterprise') {
            await prisma_1.prisma.workspace.update({
                where: { id: workspace.id },
                data: { plan: 'enterprise', planTier: 'enterprise', onboardingComplete: true }
            });
        }
        const token = app.jwt.sign({ userId: data.user.id, workspaceId: workspace.id, email }, { expiresIn: '7d' });
        return reply.send({ token, workspaceId: workspace.id });
    });
}
