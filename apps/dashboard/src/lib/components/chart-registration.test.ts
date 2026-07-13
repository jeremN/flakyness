import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the invariant AGENTS.md states:
 *
 *   "New dashboard chart types must be registered in Chart.svelte's
 *    `echarts.use([...])` or they render blank (modular ECharts imports)."
 *
 * This is the bug plan 008 found, and it is *silent*: ECharts treats an
 * unregistered series type as a no-op — it does not throw, and its dev-mode
 * warning is compiled out by `__DEV__` guards in a production build. The
 * chart's axes still paint (GridComponent is registered independently), so
 * the canvas is present, sized and non-blank while the data series has simply
 * vanished. No runtime signal exists to assert on: the E2E chart spec
 * (e2e/chart.spec.ts) passes with the bug present, as does any pageerror or
 * console check. That is *why* this guard is static.
 *
 * So instead of observing the failure, we make it unrepresentable: read the
 * registrations out of Chart.svelte, read the series types out of every chart
 * option object in the app, and assert the second set is covered by the first.
 * Fast, browser-free, and fully deterministic.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHART_COMPONENT = resolve(__dirname, 'Chart.svelte');
const SRC_ROOT = resolve(__dirname, '../..');

/**
 * Every series type ECharts 6 ships, mapped to the component that must be
 * passed to `echarts.use([...])` to enable it. Mirrors the exports of
 * `echarts/charts` — if ECharts adds a series type, add it here.
 *
 * Anything not in this map is not a series type, which is what keeps the
 * scan below from tripping over lookalikes: axis `type: 'category'`/`'value'`,
 * gradient `type: 'linear'`, dataZoom `type: 'inside'`, etc.
 */
const SERIES_TYPE_TO_COMPONENT: Record<string, string> = {
  line: 'LineChart',
  bar: 'BarChart',
  pie: 'PieChart',
  scatter: 'ScatterChart',
  effectScatter: 'EffectScatterChart',
  radar: 'RadarChart',
  tree: 'TreeChart',
  treemap: 'TreemapChart',
  sunburst: 'SunburstChart',
  boxplot: 'BoxplotChart',
  candlestick: 'CandlestickChart',
  heatmap: 'HeatmapChart',
  map: 'MapChart',
  parallel: 'ParallelChart',
  lines: 'LinesChart',
  graph: 'GraphChart',
  sankey: 'SankeyChart',
  funnel: 'FunnelChart',
  gauge: 'GaugeChart',
  pictorialBar: 'PictorialBarChart',
  themeRiver: 'ThemeRiverChart',
  custom: 'CustomChart',
  chord: 'ChordChart',
};

/** Recursively collect the app sources that could declare chart options. */
function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(path));
      continue;
    }
    // Test files are excluded so this file's own SERIES_TYPE_TO_COMPONENT map
    // and doc comments can't match the scan and make the assertion vacuous.
    if (entry.name.endsWith('.test.ts')) continue;
    if (entry.name.endsWith('.svelte') || entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

/** The identifiers passed to `echarts.use([...])` in Chart.svelte. */
function readRegisteredComponents(): string[] {
  const source = readFileSync(CHART_COMPONENT, 'utf-8');
  const match = source.match(/echarts\.use\(\[([\s\S]*?)\]\)/);
  if (!match) {
    throw new Error(
      `Could not find an \`echarts.use([...])\` call in ${CHART_COMPONENT}. ` +
        'If the registration mechanism changed, this test must be updated to match — ' +
        'do not delete it; the invariant it guards fails silently at runtime.'
    );
  }
  return match[1]
    .split(',')
    .map((identifier) => identifier.trim())
    .filter(Boolean);
}

/** Every ECharts series type referenced anywhere in the dashboard's sources. */
function findUsedSeriesTypes(): { seriesType: string; file: string }[] {
  const used: { seriesType: string; file: string }[] = [];
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const source = readFileSync(file, 'utf-8');
    for (const match of source.matchAll(/\btype:\s*['"]([A-Za-z]+)['"]/g)) {
      const seriesType = match[1];
      if (seriesType in SERIES_TYPE_TO_COMPONENT) {
        used.push({ seriesType, file: relative(SRC_ROOT, file) });
      }
    }
  }
  return used;
}

describe('Chart.svelte ECharts registration', () => {
  it('registers a component for every series type the dashboard renders', () => {
    const registered = readRegisteredComponents();
    const used = findUsedSeriesTypes();

    const missing = used
      .filter(({ seriesType }) => !registered.includes(SERIES_TYPE_TO_COMPONENT[seriesType]))
      .map(
        ({ seriesType, file }) =>
          `  • series \`type: '${seriesType}'\` in src/${file} needs \`${SERIES_TYPE_TO_COMPONENT[seriesType]}\``
      );

    expect(
      missing,
      `Unregistered ECharts series type(s). These render BLANK at runtime with no error, ` +
        `no console warning, and no failing E2E test — the chart just silently loses its data.\n` +
        `Add the component(s) to \`echarts.use([...])\` in src/lib/components/Chart.svelte:\n` +
        `${[...new Set(missing)].join('\n')}\n` +
        `Currently registered: ${registered.join(', ')}`
    ).toEqual([]);
  });

  // Without this, a scan that silently matched nothing (a renamed component, a
  // regex that stopped matching) would leave the test above passing vacuously —
  // exactly the "test that claims a guarantee it doesn't provide" failure mode
  // this file exists to eliminate.
  it('actually finds registrations and series types to compare (not vacuous)', () => {
    const registered = readRegisteredComponents();
    const used = findUsedSeriesTypes();

    expect(registered.length).toBeGreaterThan(0);
    expect(used.length).toBeGreaterThan(0);
    // The dashboard's flake-rate trend chart is a line chart; if this stops
    // holding, the scan above has probably broken rather than the app changed.
    expect(used.map(({ seriesType }) => seriesType)).toContain('line');
  });
});
