"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exotelCircuit = exports.twilioCircuit = exports.paypalCircuit = exports.stripeCircuit = exports.voiceWorkerCircuit = exports.CircuitBreaker = void 0;
class CircuitBreaker {
    state = 'CLOSED';
    failureCount = 0;
    lastFailureTime = 0;
    failureThreshold;
    resetTimeout;
    timeout;
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold ?? 5;
        this.resetTimeout = options.resetTimeout ?? 30000;
        this.timeout = options.timeout ?? 10000;
    }
    async execute(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.resetTimeout) {
                this.state = 'HALF_OPEN';
            }
            else {
                throw new Error('Circuit breaker is OPEN');
            }
        }
        try {
            const result = await Promise.race([
                fn(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), this.timeout))
            ]);
            this.onSuccess();
            return result;
        }
        catch (err) {
            this.onFailure();
            throw err;
        }
    }
    onSuccess() {
        this.failureCount = 0;
        this.state = 'CLOSED';
    }
    onFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        if (this.failureCount >= this.failureThreshold) {
            this.state = 'OPEN';
        }
    }
    getState() {
        return this.state;
    }
}
exports.CircuitBreaker = CircuitBreaker;
// Singleton instances for external services
exports.voiceWorkerCircuit = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60000 });
exports.stripeCircuit = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 });
exports.paypalCircuit = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 });
exports.twilioCircuit = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 });
exports.exotelCircuit = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60000 });
