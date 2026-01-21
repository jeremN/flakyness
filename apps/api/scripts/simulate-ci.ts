#!/usr/bin/env node
/**
 * CI Simulator Script
 * 
 * Simulates a CI pipeline sending Playwright reports to the Flackyness API.
 * Use this to test the ingestion pipeline locally.
 * 
 * Usage:
 *   pnpm simulate:ci
 *   pnpm simulate:ci --fixture=sample-report.json
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '../fixtures');

const API_URL = process.env.API_URL || 'http://localhost:8080';
const API_TOKEN = process.env.FLACKYNESS_TOKEN || 'flackyness_sample_token_12345';

interface SimulationResult {
  fixture: string;
  success: boolean;
  testRunId?: string;
  summary?: {
    total: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
  };
  error?: string;
}

async function sendReport(
  fixture: string,
  branch: string = 'main',
  commit: string = `sim-${Date.now()}`
): Promise<SimulationResult> {
  const fixturePath = join(FIXTURES_DIR, fixture);
  const reportJson = readFileSync(fixturePath, 'utf-8');

  const url = new URL(`${API_URL}/api/v1/reports`);
  url.searchParams.set('branch', branch);
  url.searchParams.set('commit', commit);
  url.searchParams.set('pipeline', `sim-${Date.now()}`);

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: reportJson,
    });

    const data = await response.json() as any;

    if (!response.ok) {
      return {
        fixture,
        success: false,
        error: data.error || `HTTP ${response.status}`,
      };
    }

    return {
      fixture,
      success: true,
      testRunId: data.testRun?.id,
      summary: data.testRun?.summary,
    };
  } catch (error) {
    return {
      fixture,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function main() {
  console.log('🎭 Flackyness CI Simulator\n');
  console.log(`API URL: ${API_URL}`);
  console.log(`Token: ${API_TOKEN.substring(0, 20)}...\n`);

  // Get fixture from args or use all fixtures
  const args = process.argv.slice(2);
  const fixtureArg = args.find(a => a.startsWith('--fixture='));
  
  let fixtures: string[];
  if (fixtureArg) {
    fixtures = [fixtureArg.split('=')[1]];
  } else {
    fixtures = readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json'));
  }

  console.log(`📁 Fixtures to send: ${fixtures.join(', ')}\n`);

  const results: SimulationResult[] = [];

  for (const fixture of fixtures) {
    console.log(`📤 Sending ${fixture}...`);
    const result = await sendReport(fixture);
    results.push(result);

    if (result.success) {
      console.log(`   ✅ Success! Test Run ID: ${result.testRunId}`);
      console.log(`   📊 Summary: ${result.summary?.total} tests (${result.summary?.passed} passed, ${result.summary?.failed} failed, ${result.summary?.flaky} flaky)\n`);
    } else {
      console.log(`   ❌ Failed: ${result.error}\n`);
    }
  }

  // Summary
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log('━'.repeat(50));
  console.log(`\n🏁 Simulation complete!`);
  console.log(`   ✅ ${successful} successful`);
  if (failed > 0) {
    console.log(`   ❌ ${failed} failed`);
    process.exit(1);
  }
}

main().catch(console.error);
