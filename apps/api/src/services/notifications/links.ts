export interface DeepLinks {
  dashboard: string | null;
  test: string | null;
}

/**
 * Build dashboard deep-links from the deployment-global DASHBOARD_BASE_URL.
 *
 * `baseUrl` null / empty / non-http(s) / unparseable → every link is null (the
 * backward-compatible default; today's payloads carry `dashboardUrl: null`).
 * When valid, `dashboard` points at the flaky list and `test` (when a testName
 * is given) at that test's trend page. Pure and null-safe — never throws.
 */
export function buildLinks(baseUrl: string | null | undefined, testName?: string): DeepLinks {
  const base = normalizeBase(baseUrl);
  if (!base) return { dashboard: null, test: null };
  return {
    dashboard: `${base}/flaky`,
    test: testName ? `${base}/tests/${encodeURIComponent(testName)}` : null,
  };
}

function normalizeBase(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const protocol = new URL(baseUrl).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return baseUrl.replace(/\/+$/, '');
}
