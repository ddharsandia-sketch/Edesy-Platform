/**
 * Structured logger - replaces console.log with consistent logging
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  data?: any
}

function log(level: LogLevel, message: string, data?: any) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data && { data })
  }

  if (process.env.NODE_ENV === 'production') {
    // In production, log as JSON for structured logging systems
    console.log(JSON.stringify(entry))
  } else {
    // In development, pretty print
    const prefix = `[${level.toUpperCase()}] ${entry.timestamp}`
    if (data) {
      console.log(`${prefix} ${message}`, data)
    } else {
      console.log(`${prefix} ${message}`)
    }
  }
}

export const logger = {
  debug: (message: string, data?: any) => log('debug', message, data),
  info: (message: string, data?: any) => log('info', message, data),
  warn: (message: string, data?: any) => log('warn', message, data),
  error: (message: string, data?: any) => log('error', message, data),
}
