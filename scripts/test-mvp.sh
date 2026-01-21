#!/bin/bash
# MVP End-to-End Test Script
# This script simulates a GitLab CI pipeline sending test results to Flackyness

set -e

# Configuration
API_URL="${FLACKYNESS_API:-http://localhost:8080}"
PROJECT_TOKEN="${FLACKYNESS_TOKEN:-test-token-abc123}"
REPORT_FILE="${1:-apps/api/fixtures/sample-report.json}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🧪 Flackyness MVP Test"
echo "======================"
echo ""

# Step 1: Check if API is running
echo -e "${YELLOW}Step 1: Checking API health...${NC}"
if curl -s "${API_URL}/health" | grep -q "ok"; then
    echo -e "${GREEN}✓ API is healthy${NC}"
else
    echo -e "${RED}✗ API is not running. Start it with: pnpm dev${NC}"
    exit 1
fi
echo ""

# Step 2: Check if report file exists
echo -e "${YELLOW}Step 2: Checking report file...${NC}"
if [ -f "$REPORT_FILE" ]; then
    echo -e "${GREEN}✓ Found report: ${REPORT_FILE}${NC}"
else
    echo -e "${RED}✗ Report file not found: ${REPORT_FILE}${NC}"
    exit 1
fi
echo ""

# Step 3: Submit report (simulating GitLab CI)
echo -e "${YELLOW}Step 3: Submitting report to Flackyness...${NC}"
echo "  API: ${API_URL}"
echo "  Project: test-project"
echo "  Branch: main"
echo "  Commit: abc123def"
echo "  Pipeline: 12345"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API_URL}/api/v1/reports?project=test-project&branch=main&commit=abc123def&pipeline=12345" \
    -H "Authorization: Bearer ${PROJECT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d @"${REPORT_FILE}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Report submitted successfully (HTTP ${HTTP_CODE})${NC}"
    echo "  Response: ${BODY}"
else
    echo -e "${RED}✗ Failed to submit report (HTTP ${HTTP_CODE})${NC}"
    echo "  Response: ${BODY}"
    exit 1
fi
echo ""

# Step 4: Verify data in dashboard
echo -e "${YELLOW}Step 4: Verifying data via API...${NC}"

# Check projects
echo "  Checking projects..."
PROJECTS=$(curl -s "${API_URL}/api/v1/projects")
echo "  Projects: ${PROJECTS}"

# Check flaky tests (if project ID is known)
echo ""
echo -e "${GREEN}✓ MVP Test Complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Open the dashboard: http://localhost:5173"
echo "  2. Check the flaky tests page"
echo "  3. Run the script again to simulate multiple CI runs"
echo ""
