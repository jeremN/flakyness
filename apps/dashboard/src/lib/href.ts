// Append `project=<id>` to a href, choosing `?` or `&` by whether the href
// already has a query string. An `undefined` projectId leaves the href
// untouched. Shared by the flaky filter pills and the layout nav (which
// previously hand-rolled two slightly different copies of this).
export function appendProjectParam(href: string, projectId: string | undefined): string {
  if (!projectId) return href;
  const sep = href.includes('?') ? '&' : '?';
  return `${href}${sep}project=${projectId}`;
}

// Build a href for `url` with `key` set to `value` (or removed entirely when
// `value` is null), preserving the pathname and every OTHER query param.
// Unlike appendProjectParam above, this REPLACES an existing value for `key`
// rather than appending a duplicate — needed because the project list and
// TeamSwitcher both link to variations of the CURRENT page, which may
// already carry a `project=` or `team=` param from a previous click. Shared
// by TeamSwitcher.svelte (`team=`) and the root layout's project link list
// (`project=`) so clicking one filter never clobbers the other.
export function withQueryParam(url: URL, key: string, value: string | null): string {
  const params = new URLSearchParams(url.searchParams);
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
  const qs = params.toString();
  return qs ? `${url.pathname}?${qs}` : url.pathname;
}
