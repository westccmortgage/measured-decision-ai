/* Strict structured-output schemas, verified as written.
 *
 * OpenAI's strict mode rejects any object whose properties are not all in
 * required — and it rejects at RUN time, in production, on a user's
 * document. This test walks the schema literals in the edge functions and
 * proves the invariant before a deploy can ship it broken.
 */
import fs from "fs";
import vm from "vm";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

function extractObjectLiteral(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        const literal = source.slice(braceStart, index + 1);
        return vm.runInNewContext(`(${literal})`);
      }
    }
  }
  return null;
}

function strictViolations(schema, path = "$") {
  const violations = [];
  if (!schema || typeof schema !== "object") return violations;
  if (schema.type === "object" && schema.properties) {
    const keys = Object.keys(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of keys) if (!required.includes(key)) violations.push(`${path}.${key} missing from required`);
    for (const key of required) if (!keys.includes(key)) violations.push(`${path}.${key} required but undeclared`);
    if (schema.additionalProperties !== false) violations.push(`${path} allows additional properties`);
    for (const key of keys) violations.push(...strictViolations(schema.properties[key], `${path}.${key}`));
  }
  if (schema.type === "array" && schema.items) violations.push(...strictViolations(schema.items, `${path}[]`));
  return violations;
}

console.log("── the document-evidence schema ──");
{
  const source = fs.readFileSync("supabase/functions/document-evidence/index.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const schema = extractObjectLiteral(source, "const documentSchema =");
  check("the schema literal parses", Boolean(schema));
  const violations = strictViolations(schema);
  check("every property is required and nothing extra is allowed",
    violations.length === 0, violations.join(" | "));
  check("delivery kinds are a closed set",
    JSON.stringify(schema?.properties?.document_kind?.enum) === '["invoice","delivery_ticket","receipt","other"]');
}

console.log("\n── the evidence inspector's component counts ──");
{
  const source = fs.readFileSync("supabase/functions/spatial-analyze/index.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const schema = extractObjectLiteral(source, "const componentCountsSchema =");
  check("the counts schema literal parses", Boolean(schema));
  const violations = strictViolations(schema, "$counts");
  check("counts are strict: every property required, nothing extra",
    violations.length === 0, violations.join(" | "));
  check("a count is an integer with a closed confidence set",
    schema?.items?.properties?.count_visible?.type === "integer"
    && JSON.stringify(schema?.items?.properties?.confidence?.enum) === '["high","medium","low"]');
}

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
