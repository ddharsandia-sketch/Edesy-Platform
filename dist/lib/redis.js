"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redis = void 0;
exports.getPubSub = getPubSub;
const ioredis_1 = __importDefault(require("ioredis"));
if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is strictly required for the API service.");
}
exports.redis = global.__redis ?? new ioredis_1.default(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
});
// Used for SSE subscriptions without blocking the main client
function getPubSub() {
    if (!global.__redisPubSub) {
        global.__redisPubSub = new ioredis_1.default(process.env.REDIS_URL, {
            maxRetriesPerRequest: 3,
        });
    }
    return global.__redisPubSub;
}
if (process.env.NODE_ENV !== 'production') {
    global.__redis = exports.redis;
}
