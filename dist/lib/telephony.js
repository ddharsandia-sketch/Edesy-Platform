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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelephonyManager = void 0;
const twilio_1 = __importDefault(require("twilio"));
class TelephonyManager {
    static instance;
    provider;
    constructor() {
        this.provider = process.env.TELEPHONY_PROVIDER || 'twilio';
    }
    static getInstance() {
        if (!TelephonyManager.instance) {
            TelephonyManager.instance = new TelephonyManager();
        }
        return TelephonyManager.instance;
    }
    /**
     * Initiate an outbound call
     */
    async makeCall(params) {
        console.log(`[TELEPHONY] Making ${this.provider} call to ${params.to}`);
        if (this.provider === 'signalwire') {
            // Dynamic import to avoid TS2307 when @signalwire/compatibility-api types are missing
            const { RestClient: SignalWireClient } = await Promise.resolve(`${'@signalwire/compatibility-api'}`).then(s => __importStar(require(s)));
            const client = SignalWireClient(process.env.SIGNALWIRE_PROJECT_ID, process.env.SIGNALWIRE_API_TOKEN, { signalwireSpaceUrl: process.env.SIGNALWIRE_SPACE_URL });
            const call = await client.calls.create({
                url: params.url,
                to: params.to,
                from: params.from,
            });
            return { callSid: call.sid };
        }
        if (this.provider === 'exotel') {
            const apiKey = process.env.EXOTEL_API_KEY;
            const apiToken = process.env.EXOTEL_API_TOKEN;
            const sid = process.env.EXOTEL_ACCOUNT_SID;
            const subdomain = process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com';
            const auth = Buffer.from(`${apiKey}:${apiToken}`).toString('base64');
            const res = await fetch(`https://${subdomain}/v1/Accounts/${sid}/Calls/connect.json`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    From: params.from,
                    To: params.to,
                    CallerId: params.from,
                    Url: params.url,
                    StatusCallback: `${process.env.NEXT_PUBLIC_API_URL}/webhooks/exotel/status`
                })
            });
            const data = await res.json();
            return { callSid: data.Call.Sid };
        }
        // Default to Twilio
        const client = (0, twilio_1.default)(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const call = await client.calls.create({
            url: params.url,
            to: params.to,
            from: params.from,
        });
        return { callSid: call.sid };
    }
    /**
     * Generate TwiML/compatible XML
     */
    generateConnectXml(roomName, token) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${process.env.LIVEKIT_URL?.replace('wss://', '')}/twilio">
      <Parameter name="roomName" value="${roomName}"/>
      <Parameter name="token" value="${token}"/>
    </Stream>
  </Connect>
</Response>`;
    }
}
exports.TelephonyManager = TelephonyManager;
