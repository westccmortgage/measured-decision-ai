import assert from "node:assert/strict";
import { backendFor } from "../analysis/backend.js";
const config = Object.freeze({
  supabaseUrl: "https://hbqlhplgqwuesrovbiye.supabase.co",
  supabasePublishableKey: "public-test-key",
  storageBucket: "property-evidence",
});
for (const host of ["measureddecision.ai", "www.measureddecision.ai",
  "deploy-preview-223--measureddecisionai.netlify.app", "localhost", "127.0.0.1", ""]) {
  const result = backendFor(host, config);
  assert.equal(result.supabaseUrl, config.supabaseUrl);
  assert.equal(result.publishableKey, config.supabasePublishableKey);
  assert.equal(result.storageBucket, config.storageBucket);
  assert.equal(result.database, "hbqlhplgqwuesrovbiye");
  assert.ok(Object.isFrozen(result));
}
// Configuration remains authoritative; no hidden project or key fallback.
assert.equal(backendFor("localhost", {}).supabaseUrl, "");
assert.equal(backendFor("localhost", {}).publishableKey, "");
console.log("ALL OK — analysis uses the existing Studio project on every host");
