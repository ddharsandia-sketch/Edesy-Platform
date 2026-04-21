"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
async function requireAuth(request, reply) {
    try {
        await request.jwtVerify();
    }
    catch (err) {
        return reply.code(401).send({ error: 'Unauthorized' });
    }
}
