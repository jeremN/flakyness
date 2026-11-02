import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { MAX_PAGES } from './types';

/**
 * audit.config.json — what to audit and how.
 *
 * Example (ViaMichelin-shaped: Didomi consent banner, canonicals pinned to prod):
 *
 *   {
 *     "urls": ["https://www.example.com/", "https://www.example.com/itineraire"],
 *     "devices": ["mobile", "desktop"],
 *     "beforeAudit": { "clickIfVisible": ["#didomi-notice-agree-button"] },
 *     "seo": { "canonicalOrigin": "https://www.example.com" }
 *   }
 */
export const configSchema = z
  .object({
    urls: z.array(z.string().url()).min(1),
    devices: z.array(z.enum(['mobile', 'desktop'])).min(1).default(['mobile']),
    categories: z.array(z.enum(['a11y', 'seo', 'perf'])).min(1).default(['a11y', 'seo', 'perf']),
    /** Per-page navigation timeout. */
    timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
    /**
     * Time to let the page settle after `load` before reading perf metrics —
     * LCP and long tasks keep arriving after the load event.
     */
    settleMs: z.number().int().min(0).max(30_000).default(3000),
    beforeAudit: z
      .object({
        /**
         * Selectors clicked (if visible) AFTER perf is measured and BEFORE the
         * a11y/SEO checks — a consent banner is real user-facing cost for perf,
         * but would otherwise dominate the a11y findings on every page.
         */
        clickIfVisible: z.array(z.string().min(1)).default([]),
        waitAfterMs: z.number().int().min(0).max(10_000).default(500),
      })
      .default({ clickIfVisible: [], waitAfterMs: 500 }),
    axe: z
      .object({
        /** axe-core tags to run. Default: WCAG 2.1 A + AA. */
        tags: z.array(z.string()).min(1).default(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']),
        /** CSS selectors excluded from the a11y scan (third-party widgets you do not own). */
        exclude: z.array(z.string()).default([]),
      })
      .default({ tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'], exclude: [] }),
    seo: z
      .object({
        canonicalOrigin: z.string().url().optional(),
      })
      .default({}),
  })
  .refine((c) => c.urls.length * c.devices.length <= MAX_PAGES, {
    message: `urls x devices must not exceed ${MAX_PAGES} (the API's per-report page cap)`,
  });

export type AuditConfig = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): AuditConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(`Invalid audit config: ${first.path.join('.') || '(root)'}: ${first.message}`);
  }
  // Duplicates would audit the same page twice (the API rejects a repeated
  // url+device pair) and double-count it in the means.
  return {
    ...result.data,
    urls: [...new Set(result.data.urls)],
    devices: [...new Set(result.data.devices)],
    categories: [...new Set(result.data.categories)],
  };
}

export async function loadConfig(path: string): Promise<AuditConfig> {
  const text = await readFile(path, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Audit config ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}
