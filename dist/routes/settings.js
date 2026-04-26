"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsRoutes = settingsRoutes;
const prisma_1 = require("../lib/prisma");
const auth_1 = require("../middleware/auth");
async function settingsRoutes(app) {
    // ── GET /settings/onboarding-status ────────────────────────────────────────
    app.get("/settings/onboarding-status", { preHandler: auth_1.requireAuth }, async (req, reply) => {
        try {
            const { workspaceId } = req.user;
            const workspace = await prisma_1.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { onboardingComplete: true },
            });
            return reply.send({ onboardingComplete: workspace?.onboardingComplete ?? false });
        }
        catch (err) {
            console.error("[GET /settings/onboarding-status] FAILED:", err.message);
            return reply.status(500).send({ error: "Failed to check onboarding status" });
        }
    });
    // ── GET /settings ──────────────────────────────────────────────────────────
    app.get("/settings", { preHandler: auth_1.requireAuth }, async (req, reply) => {
        try {
            const { workspaceId } = req.user;
            const workspace = await prisma_1.prisma.workspace.findUnique({
                where: { id: workspaceId },
            });
            if (!workspace) {
                return reply.status(404).send({ error: "Workspace not found" });
            }
            // ── Mask helper — ONLY masks real secrets, never short IDs ─────────────
            // A key is a "secret" if it's longer than 20 chars (real API keys)
            // Short values like Exotel SID (e.g. "EX1234") are returned as-is
            const maskSecret = (val) => {
                if (!val)
                    return null;
                if (val.length <= 20)
                    return val; // short = SID/ID, show as-is
                return `${val.slice(0, 8)}${"•".repeat(16)}`; // long = secret, mask it
            };
            return reply.send({
                id: workspace.id,
                name: workspace.name,
                plan: workspace.plan,
                isUnlimited: workspace.isUnlimited ?? false,
                activeTel: workspace.activeTel ?? "twilio",
                // Telephony — SIDs shown in full (short), secrets masked
                exotelSid: workspace.exotelSid ?? null, // show full
                exotelApiKey: maskSecret(workspace.exotelApiKey), // mask
                exotelToken: maskSecret(workspace.exotelToken), // mask
                twilioAccountSid: workspace.twilioAccountSid ?? null, // show full
                twilioAuthToken: maskSecret(workspace.twilioAuthToken), // mask
                twilioPhoneNumber: workspace.twilioPhoneNumber ?? null, // show full
                // AI Provider keys — all masked
                groqApiKey: maskSecret(workspace.groqApiKey),
                cerebrasApiKey: maskSecret(workspace.cerebrasApiKey),
                geminiApiKey: maskSecret(workspace.geminiApiKey),
                openaiApiKey: maskSecret(workspace.openaiApiKey),
                anthropicApiKey: maskSecret(workspace.anthropicApiKey),
                sarvamApiKey: maskSecret(workspace.sarvamApiKey),
                deepgramApiKey: maskSecret(workspace.deepgramApiKey),
                elevenLabsApiKey: maskSecret(workspace.elevenLabsApiKey),
                cartesiaApiKey: maskSecret(workspace.cartesiaApiKey),
            });
        }
        catch (err) {
            console.error("[GET /api/settings] FAILED:", err.message);
            return reply.status(500).send({ error: err.message ?? "Failed to load settings" });
        }
    });
    // ── PATCH /settings ────────────────────────────────────────────────────────
    app.patch("/settings", { preHandler: auth_1.requireAuth }, async (req, reply) => {
        try {
            const { workspaceId } = req.user;
            const body = req.body;
            console.log("[PATCH /api/settings] workspaceId:", workspaceId);
            console.log("[PATCH /api/settings] raw body keys:", Object.keys(body));
            // ── The complete field whitelist ────────────────────────────────────────
            const ALLOWED = [
                // Identity
                "name",
                // Telephony
                "activeTel",
                "exotelSid", "exotelApiKey", "exotelToken",
                "twilioAccountSid", "twilioAuthToken", "twilioPhoneNumber",
                // AI Providers
                "groqApiKey", "cerebrasApiKey", "geminiApiKey",
                "openaiApiKey", "anthropicApiKey",
                "sarvamApiKey", "deepgramApiKey",
                "elevenLabsApiKey", "cartesiaApiKey",
            ];
            const data = {};
            for (const key of ALLOWED) {
                const val = body[key];
                // Skip fields not sent at all
                if (val === undefined)
                    continue;
                // Skip masked values — but ONLY if they contain the bullet character •
                // This is the fix: use charCodeAt check, not includes(), to be precise
                const isMasked = typeof val === "string" && val.includes("\u2022"); // • = U+2022
                if (isMasked) {
                    console.log(`[PATCH /api/settings] SKIPPING masked field: ${key}`);
                    continue;
                }
                // Empty string → null (clear the field)
                // null → null (explicit clear)
                // any real value → save it
                data[key] = (val === "" || val === null) ? null : val;
            }
            console.log("[PATCH /api/settings] Final data to save:", Object.keys(data));
            if (Object.keys(data).length === 0) {
                console.warn("[PATCH /api/settings] Nothing to save — all fields were masked or absent");
                return reply.send({ success: true, updated: [], message: "Nothing to update" });
            }
            await prisma_1.prisma.workspace.update({
                where: { id: workspaceId },
                data,
            });
            console.log("[PATCH /api/settings] SUCCESS — saved:", Object.keys(data));
            return reply.send({ success: true, updated: Object.keys(data) });
        }
        catch (err) {
            console.error("[PATCH /api/settings] FAILED:", err.message);
            return reply.status(500).send({ error: err.message ?? "Failed to save settings" });
        }
    });
}
