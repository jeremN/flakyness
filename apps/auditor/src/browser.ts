import { chromium, devices, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import type { AuditConfig } from './config';
import { summarizeAxe } from './a11y';
import { computeCls, computeTbt, scorePerf } from './perf';
import { evaluateSeo, type SeoSnapshot } from './seo';
import { PERF_OBSERVERS_SCRIPT, READ_PERF_EXPRESSION, READ_SEO_EXPRESSION } from './in-page';
import type { AuditReport, Category, Check, Device, PageReport } from './types';
import { MAX_MESSAGE_LENGTH } from './types';

export const TOOL = { name: 'flackyness-auditor', version: '0.0.1' } as const;

// Mobile = a mid-range phone viewport with 4x CPU slowdown (Lighthouse's
// default mobile CPU multiplier). No network throttling: see perf.ts.
const MOBILE_CPU_THROTTLING = 4;

const DEVICE_OPTIONS: Record<Device, BrowserContextOptions> = {
  mobile: { ...devices['Pixel 7'] },
  desktop: { viewport: { width: 1350, height: 940 }, deviceScaleFactor: 1 },
};

/** Raw facts collected in the page by READ_PERF_EXPRESSION. */
interface RawPerf {
  lcp?: number;
  fcp?: number;
  ttfb?: number;
  /** null when the observer could not be registered — unmeasured, not 0. */
  shifts: number[][] | null;
  longTasks: number[][] | null;
}

async function readPerf(page: Page, device: Device): Promise<Check> {
  const raw = (await page.evaluate(READ_PERF_EXPRESSION)) as RawPerf;
  const pairs = (xs: number[][]) => xs.map((x) => [x[0], x[1]] as const);
  return scorePerf(
    {
      lcp: raw.lcp,
      fcp: raw.fcp,
      ttfb: raw.ttfb,
      cls: raw.shifts ? computeCls(pairs(raw.shifts)) : undefined,
      tbt: raw.longTasks ? computeTbt(pairs(raw.longTasks), raw.fcp) : undefined,
    },
    device
  );
}

async function readSeoSnapshot(page: Page, status: number | null, xRobotsTag: string | null): Promise<SeoSnapshot> {
  const dom = (await page.evaluate(READ_SEO_EXPRESSION)) as Omit<SeoSnapshot, 'status' | 'xRobotsTag'>;
  return { ...dom, status, xRobotsTag };
}

function failedCheck(category: Category, err: unknown): Check {
  // An internal failure of ONE check is not a page failure: the other checks
  // still count. Reported as `info` so it is visible but never a regression.
  const message = err instanceof Error ? err.message : String(err);
  return {
    category,
    score: null,
    issues: [{ id: 'audit-error', severity: 'info', message: `Check failed: ${message}`.slice(0, MAX_MESSAGE_LENGTH) }],
  };
}

async function clickIfVisible(page: Page, selectors: string[], waitAfterMs: number): Promise<void> {
  let clicked = false;
  for (const selector of selectors) {
    const target = page.locator(selector).first();
    if (await target.isVisible().catch(() => false)) {
      await target.click({ timeout: 5000 }).catch(() => {});
      clicked = true;
    }
  }
  if (clicked && waitAfterMs > 0) await page.waitForTimeout(waitAfterMs);
}

export async function auditPage(
  browser: Browser,
  url: string,
  device: Device,
  config: AuditConfig
): Promise<PageReport> {
  // A fresh context per page: cold cache and no cookies, so every run of a
  // page measures the same thing (a warm cache between pages would make the
  // audit order change the perf numbers).
  const context = await browser.newContext(DEVICE_OPTIONS[device]);
  try {
    const page = await context.newPage();
    await page.addInitScript({ content: PERF_OBSERVERS_SCRIPT });
    if (device === 'mobile') {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: MOBILE_CPU_THROTTLING });
    }

    let response;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: config.timeoutMs });
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      return { url, device, error: message.slice(0, MAX_MESSAGE_LENGTH), checks: [] };
    }
    if (config.settleMs > 0) await page.waitForTimeout(config.settleMs);

    const wants = (c: Category) => config.categories.includes(c);
    const checks: Check[] = [];

    // Perf FIRST, before anything is clicked or injected into the page.
    if (wants('perf')) checks.push(await readPerf(page, device).catch((e) => failedCheck('perf', e)));

    await clickIfVisible(page, config.beforeAudit.clickIfVisible, config.beforeAudit.waitAfterMs);

    if (wants('seo')) {
      checks.push(
        await readSeoSnapshot(page, response?.status() ?? null, response?.headers()['x-robots-tag'] ?? null)
          .then((snapshot) => evaluateSeo(snapshot, config.seo))
          .catch((e) => failedCheck('seo', e))
      );
    }

    if (wants('a11y')) {
      let builder = new AxeBuilder({ page }).withTags(config.axe.tags);
      for (const selector of config.axe.exclude) builder = builder.exclude(selector);
      checks.push(
        await builder
          .analyze()
          .then((r) => summarizeAxe({ violations: r.violations, passes: r.passes }))
          .catch((e) => failedCheck('a11y', e))
      );
    }

    return { url, device, checks };
  } finally {
    await context.close();
  }
}

export interface RunOptions {
  /** Chromium binary; defaults to Playwright's own install. */
  executablePath?: string;
  onPage?: (page: PageReport, index: number, total: number) => void;
}

/**
 * Audit every url x device, SEQUENTIALLY. Parallel pages would compete for
 * CPU and make the perf numbers depend on what else was running — the one
 * thing a trend-based regression detector cannot tolerate.
 */
export async function runAudit(config: AuditConfig, options: RunOptions = {}): Promise<AuditReport> {
  const startedAt = new Date().toISOString();
  const browser = await chromium.launch({ executablePath: options.executablePath });
  const pages: PageReport[] = [];
  try {
    const jobs = config.urls.flatMap((url) => config.devices.map((device) => ({ url, device })));
    for (const [i, job] of jobs.entries()) {
      const report = await auditPage(browser, job.url, job.device, config);
      pages.push(report);
      options.onPage?.(report, i, jobs.length);
    }
  } finally {
    await browser.close();
  }
  return { version: 1, tool: { ...TOOL }, startedAt, finishedAt: new Date().toISOString(), pages };
}
