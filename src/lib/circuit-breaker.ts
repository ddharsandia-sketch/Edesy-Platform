/**
 * Circuit Breaker implementation for external API calls
 */
interface CircuitBreakerOptions {
  failureThreshold?: number
  resetTimeout?: number
  timeout?: number
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED'
  private failureCount = 0
  private lastFailureTime = 0

  private readonly failureThreshold: number
  private readonly resetTimeout: number
  private readonly timeout: number

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5
    this.resetTimeout = options.resetTimeout ?? 30000
    this.timeout = options.timeout ?? 10000
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN'
      } else {
        throw new Error('Circuit breaker is OPEN')
      }
    }

    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Request timed out')), this.timeout)
        )
      ])

      this.onSuccess()
      return result
    } catch (err) {
      this.onFailure()
      throw err
    }
  }

  private onSuccess() {
    this.failureCount = 0
    this.state = 'CLOSED'
  }

  private onFailure() {
    this.failureCount++
    this.lastFailureTime = Date.now()

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN'
    }
  }

  getState(): CircuitState {
    return this.state
  }
}

// Singleton instances for external services
export const voiceWorkerCircuit = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60000 })
export const stripeCircuit = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 })
export const paypalCircuit = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 })
export const twilioCircuit = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 })
export const exotelCircuit = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60000 })
