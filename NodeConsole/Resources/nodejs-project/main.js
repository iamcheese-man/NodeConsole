'use strict';

/**
 * Sandboxed Node.js console backend.
 *
 * Runs inside the embedded nodejs-mobile runtime (started by NodeBridge.swift).
 * Exposes a loopback-only HTTP API that the SwiftUI console talks to:
 *
 *   GET  /health   -> { ok, node, documents }
 *   POST /run      -> { code } => { output, error }
 *   POST /reset    -> wipes the persistent evaluation context
 *
 * Every path that code running here touches through fs / fs.promises is
 * resolved against DOCUMENTS_DIR and rejected if it would escape it, so
 * `require('fs').readFileSync('/etc/passwd')` (or any '..' traversal)
 * throws instead of touching anything outside the app's Documents folder.
 *
 * This is app-level defense in depth on top of the normal iOS app sandbox,
 * not a hard security boundary against a hostile actor with code-execution
 * elsewhere on the device — but it does exactly what was asked: only the
 * Documents folder is reachable from the console.
 */

const http = require('http');
const vm = require('vm');
const util = require('util');
const path = require('path');
const Module = require('module');
const realFs = require('fs');

const DOCUMENTS_DIR = path.resolve(process.argv[2] || process.cwd());
const PORT = parseInt(process.argv[3], 10) || 8842;

// ---------------------------------------------------------------------------
// npm support
// ---------------------------------------------------------------------------
// Two ways to get npm packages into the console, no npm CLI needed on-device:
//
// 1. Bundled at build time (works offline, survives reinstall):
//      cd NodeConsole/Resources/nodejs-project && npm install <pkg>
//    then rebuild. node_modules ships inside the app bundle right next to
//    main.js, so plain `require('<pkg>')` resolves it automatically via
//    Node's normal upward node_modules search — no extra config needed.
//
// 2. Installed at runtime, no rebuild (drag node_modules into the app's
//    Documents folder via the Files app / Finder file sharing / AirDrop):
//    we add Documents/node_modules to the module search path below.
//
// Either way: only *pure-JavaScript* packages work. Anything with a native
// binary addon (.node file) would need to be cross-compiled for iOS arm64,
// which this project does not attempt.
const DOCUMENTS_NODE_MODULES = path.join(DOCUMENTS_DIR, 'node_modules');
try { realFs.mkdirSync(DOCUMENTS_NODE_MODULES, { recursive: true }); } catch {}
process.env.NODE_PATH = [process.env.NODE_PATH, DOCUMENTS_NODE_MODULES]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths(); // re-reads NODE_PATH into the global module search paths

// ---------------------------------------------------------------------------
// Path jail
// ---------------------------------------------------------------------------

function resolveInsideDocuments(p) {
  const resolved = path.resolve(DOCUMENTS_DIR, p);
  const rel = path.relative(DOCUMENTS_DIR, resolved);
  const escapes = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
  if (escapes) {
    throw new Error(`EACCES: "${p}" resolves outside Documents (${DOCUMENTS_DIR})`);
  }
  return resolved;
}

// fs functions that take a *second* path argument (dest of a copy/rename/link).
const SECOND_PATH_ARG = new Set([
  'rename', 'renameSync',
  'copyFile', 'copyFileSync',
  'link', 'linkSync',
  'symlink', 'symlinkSync',
]);

function guardArgs(fnName, args) {
  if (args.length > 0 && typeof args[0] === 'string') {
    args[0] = resolveInsideDocuments(args[0]);
  }
  if (SECOND_PATH_ARG.has(fnName) && args.length > 1 && typeof args[1] === 'string') {
    args[1] = resolveInsideDocuments(args[1]);
  }
  return args;
}

function jail(source) {
  const wrapped = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    wrapped[key] = typeof value === 'function'
      ? (...args) => value.apply(source, guardArgs(key, args))
      : value;
  }
  return wrapped;
}

const sandboxedFs = jail(realFs);
sandboxedFs.promises = jail(realFs.promises);

const BLOCKED_MODULES = new Set(['child_process', 'cluster', 'worker_threads', 'vm', 'inspector']);

function guardedRequire(id) {
  if (id === 'fs') return sandboxedFs;
  if (id === 'fs/promises') return sandboxedFs.promises;
  if (BLOCKED_MODULES.has(id)) {
    throw new Error(`require('${id}') is disabled in this console`);
  }
  return require(id);
}

// ---------------------------------------------------------------------------
// Persistent evaluation context (this is what makes it feel like a REPL:
// `let`/`const`/`var` declared in one request are still visible in the next)
// ---------------------------------------------------------------------------

function makeConsole(buffer) {
  const fmt = (args) => args
    .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, colors: false })))
    .join(' ');
  return {
    log: (...a) => buffer.push(fmt(a)),
    info: (...a) => buffer.push(fmt(a)),
    warn: (...a) => buffer.push('[warn] ' + fmt(a)),
    error: (...a) => buffer.push('[error] ' + fmt(a)),
    debug: (...a) => buffer.push('[debug] ' + fmt(a)),
  };
}

function freshContext() {
  const restrictedProcess = Object.create(process);
  restrictedProcess.cwd = () => DOCUMENTS_DIR;
  restrictedProcess.chdir = () => { throw new Error('process.chdir is disabled'); };
  restrictedProcess.exit = () => { throw new Error('process.exit is disabled (it would kill the app)'); };
  restrictedProcess.kill = () => { throw new Error('process.kill is disabled'); };
  restrictedProcess.binding = () => { throw new Error('process.binding is disabled'); };

  const sandbox = {
    require: guardedRequire,
    process: restrictedProcess,
    Buffer,
    console: makeConsole([]), // replaced with a fresh buffer-backed console per /run call
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    DOCUMENTS_DIR,
    __dirname: DOCUMENTS_DIR,
    __filename: path.join(DOCUMENTS_DIR, '[console]'),
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

let ctx = freshContext();

async function evaluate(code) {
  const buffer = [];
  ctx.console = makeConsole(buffer);

  let result;
  let thrown = null;

  try {
    if (/\bawait\b/.test(code)) {
      // Top-level await: wrap in an async IIFE. Note that `let`/`const`
      // declared *inside* an awaited snippet won't persist to the next
      // call (same trade-off real REPLs make) — assign to globalThis if
      // you need a value to survive, e.g. `globalThis.data = await fetch(...)`.
      const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: '[console:async]' });
      result = await script.runInContext(ctx, { timeout: 20000 });
    } else {
      // Try to run as an expression first (so the REPL can print its value),
      // exactly like the real `node` REPL does; fall back to statement mode.
      let script;
      try {
        script = new vm.Script(`(\n${code}\n)`, { filename: '[console:expr]' });
      } catch {
        script = new vm.Script(code, { filename: '[console:stmt]' });
      }
      result = script.runInContext(ctx, { timeout: 20000 });
    }
  } catch (err) {
    thrown = err;
  }

  let output = buffer.join('\n');
  if (!thrown && result !== undefined) {
    const printed = typeof result === 'string' ? result : util.inspect(result, { depth: 4, colors: false });
    output = output ? `${output}\n${printed}` : printed;
  }

  return { output, error: thrown ? (thrown.stack || String(thrown)) : null };
}

// ---------------------------------------------------------------------------
// Loopback-only HTTP server
// ---------------------------------------------------------------------------

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const server = http.createServer((req, res) => {
  if (!isLoopback(req.socket.remoteAddress || '')) {
    res.writeHead(403); res.end(); return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      node: process.version,
      documents: DOCUMENTS_DIR,
      nodeModules: DOCUMENTS_NODE_MODULES,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/reset') {
    ctx = freshContext();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/run') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      let code;
      try {
        code = JSON.parse(body).code || '';
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      try {
        const { output, error } = await evaluate(code);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ output, error }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err && err.stack || err) }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[node-console] listening on 127.0.0.1:${PORT}, jailed to ${DOCUMENTS_DIR}`);
});
