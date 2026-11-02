#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from './config';
import { runAudit } from './browser';
import { formatRegressions, formatReport } from './summary';
import { uploadReport } from './upload';

const USAGE = `Usage: flackyness-audit --config <audit.config.json> [options]

Audits every URL in the config for accessibility, SEO and performance, then
uploads the report to a Flackyness API (POST /api/v1/audits).

Options:
  --config <path>         Audit config (required)
  --api-url <url>         Flackyness API base URL      [env FLACKYNESS_API]
  --token <token>         Project ingest token          [env FLACKYNESS_TOKEN]
  --branch <name>         Branch the audit belongs to   (default: main)
  --commit <sha>          Commit SHA (optional for scheduled audits)
  --pipeline <id>         CI pipeline id
  --output <path>         Also write the raw report JSON to this file
  --dry-run               Audit and print, but do not upload
  --fail-on-regression    Exit 3 if the API reports regressions
  --chromium <path>       Chromium binary               [env AUDIT_CHROMIUM_PATH]
  -h, --help

Exit codes: 0 ok · 1 usage/config error · 2 audit or upload failed · 3 regressions`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      'api-url': { type: 'string' },
      token: { type: 'string' },
      branch: { type: 'string', default: 'main' },
      commit: { type: 'string' },
      pipeline: { type: 'string' },
      output: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'fail-on-regression': { type: 'boolean', default: false },
      chromium: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.config) {
    console.error(`--config is required.\n\n${USAGE}`);
    return 1;
  }

  const apiUrl = values['api-url'] ?? process.env.FLACKYNESS_API;
  const token = values.token ?? process.env.FLACKYNESS_TOKEN;
  if (!values['dry-run'] && (!apiUrl || !token)) {
    console.error('An API URL and a project token are required to upload (or pass --dry-run).');
    return 1;
  }

  let config;
  try {
    config = await loadConfig(values.config);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const total = config.urls.length * config.devices.length;
  console.log(`Auditing ${config.urls.length} URL(s) x ${config.devices.length} device(s) = ${total} page(s)…`);

  let report;
  try {
    report = await runAudit(config, {
      executablePath: values.chromium ?? process.env.AUDIT_CHROMIUM_PATH,
      onPage: (page, i, n) =>
        console.log(`  [${i + 1}/${n}] ${page.error ? '✗' : '✓'} ${page.device} ${page.url}`),
    });
  } catch (err) {
    console.error(`Audit failed: ${(err as Error).message}`);
    return 2;
  }

  console.log(`\n${formatReport(report)}\n`);
  if (values.output) await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
  if (values['dry-run']) return 0;

  try {
    const res = await uploadReport(report, {
      apiUrl: apiUrl as string,
      token: token as string,
      branch: values.branch,
      commit: values.commit,
      pipeline: values.pipeline,
    });
    console.log(`Uploaded audit run ${res.auditRun.id} (${res.auditRun.project}, ${res.auditRun.branch}).`);
    console.log(formatRegressions(res.regressions, res.previousRunId));
    return values['fail-on-regression'] && res.regressions.length > 0 ? 3 : 0;
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  }
);
