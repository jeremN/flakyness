// Append `project=<id>` to a href, choosing `?` or `&` by whether the href
// already has a query string. An `undefined` projectId leaves the href
// untouched. Shared by the flaky filter pills and the layout nav (which
// previously hand-rolled two slightly different copies of this).
export function appendProjectParam(href: string, projectId: string | undefined): string {
  if (!projectId) return href;
  const sep = href.includes('?') ? '&' : '?';
  return `${href}${sep}project=${projectId}`;
}
