// Production entry point of the dashboard: `node runtime/server.js`.
// It starts adapter-node's own server (build/index.js), so PORT, HOST,
// SOCKET_PATH, the timeouts and the graceful shutdown work as documented.
// It adds two things, both read at runtime: the ORIGIN variable (see
// origin.js) and TRUSTED_PROXY_IPS for the client address (see
// client-address.js).
import process from 'node:process';
import { configureOrigin } from './origin.js';
import { configureClientAddress } from './client-address.js';

const pinOrigin = configureOrigin(process.env);
const pinClientAddress = configureClientAddress(process.env);

// Import AFTER both configure calls: adapter-node reads PROTOCOL_HEADER,
// HOST_HEADER and ADDRESS_HEADER when this module loads. The URL form keeps the type checker
// out of the generated build.
const build = new URL('../build/index.js', import.meta.url).href;
/** @type {{ server: import('node:http').Server }} */
const { server } = await import(build);

// Each runs before adapter-node's own 'request' listener. No request can
// arrive earlier: connections are I/O events, and these lines run in the same
// microtask chain that finished loading build/index.js.
if (pinOrigin) server.prependListener('request', pinOrigin);
if (pinClientAddress) server.prependListener('request', pinClientAddress);
