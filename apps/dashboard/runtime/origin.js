// Runtime ORIGIN support for adapter-node 6.
//
// adapter-node 6 removed the ORIGIN environment variable. Its replacement,
// SvelteKit's `paths.origin`, is fixed at build time, so one published image
// could serve only one URL. adapter-node 6 still reads PROTOCOL_HEADER and
// HOST_HEADER at runtime. This module points them at two internal headers,
// and runtime/server.js writes ORIGIN into those headers on every request.
//
// The server always OVERWRITES the two headers, so a client cannot choose
// its own origin by sending them.

export const PROTOCOL_HEADER = 'x-flackyness-origin-proto';
export const HOST_HEADER = 'x-flackyness-origin-host';

// adapter-node variables that also change the request origin. They cannot be
// combined with ORIGIN: the result would depend on which one wins.
const CONFLICTING = ['PROTOCOL_HEADER', 'HOST_HEADER', 'PORT_HEADER'];

/**
 * Parse ORIGIN into the protocol and host that adapter-node expects.
 * A trailing slash and a default port are accepted. A path, a query, a
 * fragment, credentials or a non-http(s) scheme are not.
 * @param {string} value
 * @returns {{ protocol: string, host: string }}
 */
export function parseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`ORIGIN must be an absolute URL such as https://flaky.example.com, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`ORIGIN must use http or https, got ${JSON.stringify(value)}`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`ORIGIN must be an origin only (no path, query, fragment or credentials), got ${JSON.stringify(value)}`);
  }
  return { protocol: url.protocol.slice(0, -1), host: url.host };
}

/**
 * Read ORIGIN from `env`. When it is set, point adapter-node's
 * PROTOCOL_HEADER and HOST_HEADER at the internal headers (this mutates
 * `env`) and return the function that writes them on a request. When it is
 * not set, change nothing and return null.
 *
 * Call this BEFORE importing the build: adapter-node reads these variables
 * once, when its handler module loads.
 * @param {Record<string, string | undefined>} env
 * @returns {((req: import('node:http').IncomingMessage) => void) | null}
 */
export function configureOrigin(env) {
  const raw = env.ORIGIN;
  if (raw === undefined || raw === '') return null;

  const conflicts = CONFLICTING.filter((name) => env[name]);
  if (conflicts.length > 0) {
    throw new Error(`Set ORIGIN or ${conflicts.join('/')}, not both`);
  }

  const { protocol, host } = parseOrigin(raw);
  env.PROTOCOL_HEADER = PROTOCOL_HEADER;
  env.HOST_HEADER = HOST_HEADER;

  return (req) => {
    req.headers[PROTOCOL_HEADER] = protocol;
    req.headers[HOST_HEADER] = host;
  };
}
