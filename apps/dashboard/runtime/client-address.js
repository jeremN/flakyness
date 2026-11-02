// Client address behind a reverse proxy (backlog #31).
//
// Without help, adapter-node reports the socket address. Behind a reverse
// proxy that is the proxy's address for every visitor, so the API's per-IP
// rate limits (the login throttle above all) become one bucket for the whole
// installation.
//
// adapter-node's own fix, ADDRESS_HEADER=x-forwarded-for, trusts the header
// from ANY socket: a client that reaches the dashboard directly picks its own
// address. This module trusts X-Forwarded-For only from the addresses in
// TRUSTED_PROXY_IPS. It points ADDRESS_HEADER at an internal header, and
// runtime/server.js OVERWRITES that header on every request, so a client
// cannot set it.

export const CLIENT_ADDRESS_HEADER = 'x-flackyness-client-ip';

// adapter-node variables that also decide the client address. They cannot be
// combined with TRUSTED_PROXY_IPS: the result would depend on which one wins.
const CONFLICTING = ['ADDRESS_HEADER', 'XFF_DEPTH'];

/** @param {string} ip */
function normalize(ip) {
  const trimmed = ip.trim();
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

/**
 * The client address for one request. From an untrusted socket, the socket
 * address, whatever the headers say. From a trusted proxy, the rightmost
 * X-Forwarded-For entry that is not itself a trusted proxy: proxies APPEND,
 * so the entries to the left of it were written by the client.
 * @param {string} socketAddress
 * @param {string | undefined} forwardedFor
 * @param {string[]} trusted normalized addresses
 */
export function resolveClientAddress(socketAddress, forwardedFor, trusted) {
  const socket = normalize(socketAddress);
  if (!trusted.includes(socket)) return socket;

  const hops = (forwardedFor ?? '')
    .split(',')
    .map(normalize)
    .filter((hop) => hop !== '');
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trusted.includes(hops[i])) return hops[i];
  }
  return socket;
}

/**
 * Read TRUSTED_PROXY_IPS from `env`. When it is set, point adapter-node's
 * ADDRESS_HEADER at the internal header (this mutates `env`) and return the
 * function that writes it on a request. When it is not set, change nothing
 * and return null.
 *
 * Call this BEFORE importing the build: adapter-node reads ADDRESS_HEADER
 * once, when its handler module loads.
 * @param {Record<string, string | undefined>} env
 * @returns {((req: import('node:http').IncomingMessage) => void) | null}
 */
export function configureClientAddress(env) {
  const trusted = (env.TRUSTED_PROXY_IPS ?? '')
    .split(',')
    .map(normalize)
    .filter((ip) => ip !== '');
  if (trusted.length === 0) return null;

  const conflicts = CONFLICTING.filter((name) => env[name]);
  if (conflicts.length > 0) {
    throw new Error(`Set TRUSTED_PROXY_IPS or ${conflicts.join('/')}, not both`);
  }

  env.ADDRESS_HEADER = CLIENT_ADDRESS_HEADER;

  return (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    req.headers[CLIENT_ADDRESS_HEADER] = resolveClientAddress(
      req.socket.remoteAddress ?? '',
      Array.isArray(forwarded) ? forwarded.join(',') : forwarded,
      trusted
    );
  };
}
