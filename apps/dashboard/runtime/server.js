// Production entry point of the dashboard: `node runtime/server.js`.
// It starts adapter-node's own server (build/index.js), so PORT, HOST,
// SOCKET_PATH, the timeouts and the graceful shutdown work as documented.
// It adds one thing: the ORIGIN variable, read at runtime (see origin.js).
import process from 'node:process';
import { configureOrigin } from './origin.js';

const pinOrigin = configureOrigin(process.env);

// Import AFTER configureOrigin(): adapter-node reads PROTOCOL_HEADER and
// HOST_HEADER when this module loads. The URL form keeps the type checker
// out of the generated build.
const build = new URL('../build/index.js', import.meta.url).href;
/** @type {{ server: import('node:http').Server }} */
const { server } = await import(build);

if (pinOrigin) {
  // Runs before adapter-node's own 'request' listener. No request can arrive
  // earlier: connections are I/O events, and this line runs in the same
  // microtask chain that finished loading build/index.js.
  server.prependListener('request', pinOrigin);
}
