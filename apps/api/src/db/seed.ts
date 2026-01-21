import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createHash } from 'crypto';
import * as schema from './schema';
import 'dotenv/config';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const client = postgres(connectionString);
const db = drizzle(client, { schema });

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function seed() {
  console.log('🌱 Starting database seed...\n');

  // Create sample project with API token
  const sampleToken = 'flackyness_sample_token_12345';
  const tokenHash = hashToken(sampleToken);

  const [project] = await db
    .insert(schema.projects)
    .values({
      name: 'sample-project',
      gitlabProjectId: '12345',
      tokenHash,
    })
    .onConflictDoNothing({ target: schema.projects.name })
    .returning();

  if (project) {
    console.log('✅ Created sample project:', project.name);
    console.log('   ID:', project.id);
    console.log('   API Token:', sampleToken);
    console.log('   (Use this token for Authorization: Bearer <token>)\n');

    // Create sample test run
    const [testRun] = await db
      .insert(schema.testRuns)
      .values({
        projectId: project.id,
        branch: 'main',
        commitSha: 'abc123def456789012345678901234567890abcd',
        pipelineId: '1001',
        startedAt: new Date(Date.now() - 60000),
        finishedAt: new Date(),
        totalTests: 10,
        passed: 7,
        failed: 2,
        skipped: 0,
        flaky: 1,
      })
      .returning();

    console.log('✅ Created sample test run:', testRun.id);

    // Create sample test results
    const testResults = [
      { testName: 'Login flow › should login successfully', testFile: 'e2e/auth.spec.ts', status: 'passed', durationMs: 2500 },
      { testName: 'Login flow › should show error on invalid credentials', testFile: 'e2e/auth.spec.ts', status: 'passed', durationMs: 1800 },
      { testName: 'Dashboard › should load dashboard', testFile: 'e2e/dashboard.spec.ts', status: 'passed', durationMs: 3200 },
      { testName: 'Dashboard › should filter by date', testFile: 'e2e/dashboard.spec.ts', status: 'flaky', durationMs: 4500, retryCount: 2 },
      { testName: 'Settings › should update profile', testFile: 'e2e/settings.spec.ts', status: 'passed', durationMs: 2100 },
      { testName: 'Settings › should change password', testFile: 'e2e/settings.spec.ts', status: 'failed', durationMs: 1900, errorMessage: 'TimeoutError: Element not found' },
      { testName: 'Checkout › should add item to cart', testFile: 'e2e/checkout.spec.ts', status: 'passed', durationMs: 2800 },
      { testName: 'Checkout › should complete purchase', testFile: 'e2e/checkout.spec.ts', status: 'failed', durationMs: 5500, errorMessage: 'AssertionError: Expected payment to succeed' },
      { testName: 'Search › should return results', testFile: 'e2e/search.spec.ts', status: 'passed', durationMs: 1500 },
      { testName: 'Search › should handle empty query', testFile: 'e2e/search.spec.ts', status: 'passed', durationMs: 800 },
    ];

    for (const result of testResults) {
      await db.insert(schema.testResults).values({
        testRunId: testRun.id,
        testName: result.testName,
        testFile: result.testFile,
        status: result.status,
        durationMs: result.durationMs,
        retryCount: result.retryCount ?? 0,
        errorMessage: result.errorMessage ?? null,
      });
    }

    console.log('✅ Created', testResults.length, 'sample test results\n');

    // Create flaky test record
    await db.insert(schema.flakyTests).values({
      projectId: project.id,
      testName: 'Dashboard › should filter by date',
      testFile: 'e2e/dashboard.spec.ts',
      firstDetected: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
      lastSeen: new Date(),
      flakeCount: 3,
      totalRuns: 15,
      flakeRate: '0.2000', // 20%
      status: 'active',
    });

    console.log('✅ Created sample flaky test record\n');
  } else {
    console.log('ℹ️  Sample project already exists, skipping...\n');
  }

  console.log('🎉 Seed completed successfully!');
  await client.end();
  process.exit(0);
}

seed().catch((error) => {
  console.error('❌ Seed failed:', error);
  process.exit(1);
});
