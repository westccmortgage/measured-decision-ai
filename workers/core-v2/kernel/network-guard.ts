/* THE NETWORK, CLOSED.
 *
 * The dry run and the simulation must not be able to reach a provider, a
 * database or anything else outside the process — not by accident, not by a
 * mocked executor that turns out not to be a mock. This closes every door
 * Node offers: `fetch` (frozen, so it cannot be put back), `http` and `https`
 * requests, raw `net` and `tls` connections, DNS, `WebSocket`, and child
 * processes that could do any of it on the engine's behalf. Each attempt
 * throws and is counted; the simulation's summary reports the count.
 *
 * This is the one file in the engine that imports a transport module, and it
 * imports each only to replace it. `tests/nothing-real.mjs` holds it to that.
 */
import child_process from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

export type NetworkGuard = { tripped: () => number; doors: string[] };

let installed: NetworkGuard | null = null;

export function closeTheNetwork(): NetworkGuard {
  if (installed) return installed;
  let count = 0;
  const closed: string[] = [];
  const refuseFor = (door: string) => {
    closed.push(door);
    return function refuse(): never { count++; throw new Error(`core-v2: the network is closed in this mode (${door})`); };
  };
  const seal = (target: object, name: string, door: string) => {
    if (!(name in target)) return;
    Object.defineProperty(target, name, { value: refuseFor(door), writable: false, configurable: false, enumerable: true });
  };

  seal(globalThis, "fetch", "fetch");
  seal(globalThis, "WebSocket", "WebSocket");
  seal(http, "request", "http.request"); seal(http, "get", "http.get");
  seal(https, "request", "https.request"); seal(https, "get", "https.get");
  seal(net, "connect", "net.connect"); seal(net, "createConnection", "net.createConnection");
  seal(net.Socket.prototype, "connect", "net.Socket.connect");
  seal(tls, "connect", "tls.connect");
  seal(dns, "lookup", "dns.lookup"); seal(dns, "resolve", "dns.resolve"); seal(dns, "resolve4", "dns.resolve4"); seal(dns, "resolve6", "dns.resolve6");
  seal(dns.promises, "lookup", "dns.promises.lookup"); seal(dns.promises, "resolve", "dns.promises.resolve");
  for (const name of ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]) seal(child_process, name, `child_process.${name}`);
  /* Named ESM imports of the builtins see the replacements too. */
  syncBuiltinESMExports();

  installed = { tripped: () => count, doors: closed };
  return installed;
}
