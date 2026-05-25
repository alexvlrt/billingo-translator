// tests/load-script.js
// Loads plain (non-module) browser-style script files into a fresh vm
// context and returns the resulting globalThis.BillingoTranslator binding.
// Used by the unit tests to exercise content-script source files that cannot
// use ESM export (Chrome MV3 content scripts run in classical script mode).
//
// Signature:
//   loadBillingoTranslator(paths, globals?)
//   - paths: string | string[]  — one or more relative paths to load in order
//   - globals: object           — optional extra globals to inject into the sandbox
//                                 (e.g. { document, MutationObserver, Node, NodeFilter })

import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadBillingoTranslator(paths, globals = {}) {
  const pathList = Array.isArray(paths) ? paths : [paths];
  const sandbox = { ...globals };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const rel of pathList) {
    const code = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    vm.runInContext(code, sandbox);
  }

  return sandbox.BillingoTranslator;
}
