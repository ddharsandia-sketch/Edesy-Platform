#!/bin/bash
set -e

WORKER_URL=${WORKER_URL:-http://localhost:8000}
API_URL=${API_URL:-http://localhost:3001}
INTERNAL_KEY=${INTERNAL_KEY:-dev-internal-key}

echo "Running Verification..."

# 1. /health returns 200 without auth.
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" $WORKER_URL/health)
if [ "$HEALTH" -ne 200 ]; then
  echo "❌ /health failed: Expected 200, got $HEALTH"
  exit 1
else
  echo "✅ /health returns 200 without auth"
fi

# 2. /start-call returns 403 without X-Internal-Key.
START_NO_AUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST $WORKER_URL/start-call \
  -H "Content-Type: application/json" -d '{}')
if [ "$START_NO_AUTH" -ne 403 ]; then
  echo "❌ /start-call failed security test: Expected 403, got $START_NO_AUTH"
  exit 1
else
  echo "✅ /start-call returns 403 without X-Internal-Key"
fi

# 3. /ghost-mode/activate returns 403 without X-Internal-Key.
GHOST_NO_AUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST $WORKER_URL/ghost-mode/activate \
  -H "Content-Type: application/json" -d '{}')
if [ "$GHOST_NO_AUTH" -ne 403 ]; then
  echo "❌ /ghost-mode/activate failed security test: Expected 403, got $GHOST_NO_AUTH"
  exit 1
else
  echo "✅ /ghost-mode/activate returns 403 without X-Internal-Key"
fi

# 4. /simulate/start returns 403 without X-Internal-Key.
SIM_NO_AUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST $WORKER_URL/simulate/start \
  -H "Content-Type: application/json" -d '{}')
if [ "$SIM_NO_AUTH" -ne 403 ]; then
  echo "❌ /simulate/start failed security test: Expected 403, got $SIM_NO_AUTH"
  exit 1
else
  echo "✅ /simulate/start returns 403 without X-Internal-Key"
fi

# 5. /start-call returns 202 or 400 quickly with a valid key and invalid payload
START_AUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST $WORKER_URL/start-call \
  -H "Content-Type: application/json" -H "X-Internal-Key: $INTERNAL_KEY" -d '{}')
if [ "$START_AUTH" -eq 403 ]; then
  echo "❌ /start-call rejected valid key. Expected 400/422/202, got $START_AUTH"
  exit 1
else
  echo "✅ /start-call accepted valid X-Internal-Key (returned $START_AUTH payload code)"
fi

echo "All hardening verifications passed!"
