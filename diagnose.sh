#!/bin/bash
# EDESY DIAGNOSTIC SCRIPT
# Run this from your repo root: bash diagnose.sh > diagnosis.txt 2>&1
# Then paste diagnosis.txt here

REPO="/Users/jabirul/ANTIGRAVITY/Edesy/voice-ai-platform"
cd "$REPO" || { echo "FATAL: Repo not found at $REPO"; exit 1; }

echo "====== EDESY DIAGNOSTIC REPORT ======"
echo "Date: $(date)"
echo "Node: $(node --version)"
echo "NPM:  $(npm --version)"
echo ""

echo "====== 1. DIRECTORY STRUCTURE ======"
find apps/api/src/routes -name "*.ts" | sort
find apps/web/src/app/dashboard -name "*.tsx" -o -name "page.tsx" | sort | head -40
echo ""

echo "====== 2. BILLING / PAYMENT ROUTES ======"
grep -rn "billing\|paypal\|stripe\|payment\|checkout\|subscription"   apps/api/src/routes/ --include="*.ts" -l
grep -rn "billing\|paypal\|portal\|checkout"   apps/web/src/app/ --include="*.tsx" --include="*.ts" -l
echo ""

echo "====== 3. BILLING ROUTE CONTENT ======"
find apps/api/src/routes -name "*billing*" -o -name "*payment*" -o -name "*subscription*" |   xargs cat 2>/dev/null || echo "NO BILLING ROUTE FILE FOUND"
echo ""

echo "====== 4. GOOGLE OAUTH / CALENDAR ======"
grep -rn "google\|calendar\|googleapis\|oauth"   apps/api/src/ --include="*.ts" -l 2>/dev/null
grep -rn "google_calendar\|googleCalendar\|calendar"   apps/api/src/routes/ --include="*.ts" 2>/dev/null | head -20
echo ""

echo "====== 5. INTEGRATIONS ROUTE ======"
find apps/api/src/routes -name "*integrat*" | xargs cat 2>/dev/null | head -80
echo ""

echo "====== 6. KNOWLEDGE BASE ======"
find apps/api/src/routes -name "*knowledge*" -o -name "*rag*" -o -name "*document*" |   xargs cat 2>/dev/null | head -80
grep -rn "knowledge\|document\|upload\|rag\|vector"   apps/api/src/routes/ --include="*.ts" -l 2>/dev/null
echo ""

echo "====== 7. AGENT CREATION ROUTE ======"
grep -rn "POST.*agents\|createAgent\|agent.*create"   apps/api/src/routes/ --include="*.ts" | head -20
find apps/api/src/routes -name "*agent*" | xargs head -60 2>/dev/null
echo ""

echo "====== 8. AGENT DEPLOY / LIVE ======"
grep -rn "deploy\|phone.*number\|provisionNumber\|live\|activate"   apps/api/src/routes/ --include="*.ts" | head -20
echo ""

echo "====== 9. PRISMA SCHEMA — KEY MODELS ======"
grep -A 3 "model Agent\|model Workspace\|model KnowledgeBase\|model Integration"   apps/api/prisma/schema.prisma 2>/dev/null
echo ""

echo "====== 10. ENV VARIABLES PRESENT (keys only, no values) ======"
cat apps/api/.env 2>/dev/null | cut -d'=' -f1 | sort
echo "---"
cat apps/web/.env.local 2>/dev/null | cut -d'=' -f1 | sort
echo ""

echo "====== 11. RECENT ERRORS IN LOGS (Railway) ======"
echo "Run manually: railway logs --tail 100"
echo ""

echo "====== 12. app.ts — ALL REGISTERED ROUTES ======"
grep -n "register\|route\|prefix" apps/api/src/app.ts 2>/dev/null | head -40
echo ""

echo "====== 13. TYPESCRIPT ERRORS ======"
cd apps/api && npx tsc --noEmit 2>&1 | head -40
cd "$REPO"
echo ""

echo "====== DONE ======"
echo "Paste the full output of this file to get your fixes"
