import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

export async function settingsRoutes(app: FastifyInstance) {

  // ── GET /api/settings ──────────────────────────────────────────────────────
  app.get("/api/settings", { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { workspaceId } = (req as any).user;

      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
      });

      if (!workspace) {
        return reply.status(404).send({ error: "Workspace not found" });
      }

      // ── Mask helper — ONLY masks real secrets, never short IDs ─────────────
      // A key is a "secret" if it's longer than 20 chars (real API keys)
      // Short values like Exotel SID (e.g. "EX1234") are returned as-is
      const maskSecret = (val: string | null | undefined): string | null => {
        if (!val) return null;
        if (val.length <= 20) return val;          // short = SID/ID, show as-is
        return `${val.slice(0, 8)}${"•".repeat(16)}`;  // long = secret, mask it
      };

      return reply.send({
        id:               workspace.id,
        name:             workspace.name,
        plan:             workspace.plan,
        isUnlimited:      (workspace as any).isUnlimited ?? false,
        activeTel:        workspace.activeTel ?? "twilio",

        // Telephony — SIDs shown in full (short), secrets masked
        exotelSid:        workspace.exotelSid   ?? null,           // show full
        exotelApiKey:     maskSecret(workspace.exotelApiKey),      // mask
        exotelToken:      maskSecret(workspace.exotelToken),       // mask
        twilioAccountSid: workspace.twilioAccountSid ?? null,      // show full
        twilioAuthToken:  maskSecret(workspace.twilioAuthToken),   // mask
        twilioPhoneNumber: workspace.twilioPhoneNumber ?? null,    // show full

        // AI Provider keys — all masked
        groqApiKey:       maskSecret((workspace as any).groqApiKey),
        cerebrasApiKey:   maskSecret((workspace as any).cerebrasApiKey),
        geminiApiKey:     maskSecret((workspace as any).geminiApiKey),
        openaiApiKey:     maskSecret((workspace as any).openaiApiKey),
        anthropicApiKey:  maskSecret((workspace as any).anthropicApiKey),
        sarvamApiKey:     maskSecret((workspace as any).sarvamApiKey),
        deepgramApiKey:   maskSecret((workspace as any).deepgramApiKey),
        elevenLabsApiKey: maskSecret((workspace as any).elevenLabsApiKey),
        cartesiaApiKey:   maskSecret((workspace as any).cartesiaApiKey),
      });

    } catch (err: any) {
      console.error("[GET /api/settings] FAILED:", err.message);
      return reply.status(500).send({ error: err.message ?? "Failed to load settings" });
    }
  });

  // ── PATCH /api/settings ────────────────────────────────────────────────────
  app.patch("/api/settings", { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { workspaceId } = (req as any).user;
      const body = req.body as Record<string, any>;

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

      const data: Record<string, any> = {};

      for (const key of ALLOWED) {
        const val = body[key];

        // Skip fields not sent at all
        if (val === undefined) continue;

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

      await prisma.workspace.update({
        where: { id: workspaceId },
        data,
      });

      console.log("[PATCH /api/settings] SUCCESS — saved:", Object.keys(data));
      return reply.send({ success: true, updated: Object.keys(data) });

    } catch (err: any) {
      console.error("[PATCH /api/settings] FAILED:", err.message);
      return reply.status(500).send({ error: err.message ?? "Failed to save settings" });
    }
  });
}
