import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const SITE_DIR = join(import.meta.dirname, '../../fixtures/site');

/**
 * Serves apps/auditor/fixtures/site on an ephemeral 127.0.0.1 port.
 *
 *  - `__PORT__` in a page is replaced with the real port (absolute hreflangs).
 *  - `/noindex.html` serves good.html with `X-Robots-Tag: noindex` — the
 *    header-only variant of the noindex check, which no static file can express.
 *  - anything else that is not a file is a 404.
 */
export async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const file = path === '/noindex.html' ? 'good.html' : path.replace(/^\/+/, '');
    if (!/^[a-z-]+\.html$/.test(file)) {
      res.writeHead(404, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Not found</title>');
      return;
    }
    try {
      const port = (server.address() as AddressInfo).port;
      const body = (await readFile(join(SITE_DIR, file), 'utf-8')).replaceAll('__PORT__', String(port));
      const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
      if (path === '/noindex.html') headers['X-Robots-Tag'] = 'noindex';
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
