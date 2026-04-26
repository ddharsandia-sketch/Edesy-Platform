"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
function log(level, message, data) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...(data && { data })
    };
    if (process.env.NODE_ENV === 'production') {
        // In production, log as JSON for structured logging systems
        console.log(JSON.stringify(entry));
    }
    else {
        // In development, pretty print
        const prefix = `[${level.toUpperCase()}] ${entry.timestamp}`;
        if (data) {
            console.log(`${prefix} ${message}`, data);
        }
        else {
            console.log(`${prefix} ${message}`);
        }
    }
}
exports.logger = {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),
};
