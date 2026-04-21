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
exports.fireCrmWebhooks = fireCrmWebhooks;
const prisma_1 = require("./prisma");
/**
 * Fire all configured CRM webhooks for a workspace after a call ends.
 * Each workspace can configure 0-N webhook endpoints in Settings.
 * We attempt all webhooks and log failures individually.
 */
async function fireCrmWebhooks(workspaceId, payload) {
    const webhooks = await prisma_1.prisma.webhook.findMany({
        where: { workspaceId, isActive: true }
    });
    if (webhooks.length === 0)
        return;
    const results = await Promise.allSettled(webhooks.map(webhook => fireWebhook(webhook, payload)));
    results.forEach((result, i) => {
        if (result.status === 'rejected') {
            console.warn(`[CRM] Webhook ${webhooks[i].url} failed:`, result.reason);
        }
    });
}
async function fireWebhook(webhook, payload) {
    const body = JSON.stringify({
        event: 'call.completed',
        timestamp: new Date().toISOString(),
        data: payload
    });
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'VoiceAI-Platform/1.0',
    };
    // HMAC signature if secret is configured
    if (webhook.secret) {
        const { createHmac } = await Promise.resolve().then(() => __importStar(require('crypto')));
        const signature = createHmac('sha256', webhook.secret)
            .update(body)
            .digest('hex');
        headers['X-VoiceAI-Signature'] = `sha256=${signature}`;
    }
    const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000), // 10 second timeout
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    console.log(`[CRM] Webhook ${webhook.url} → ${response.status}`);
}
