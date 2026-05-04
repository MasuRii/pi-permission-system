import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const permissionStates = new Set(["allow", "deny", "ask"]);

function readJson(relativePath) {
  const filePath = join(root, relativePath);
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validatePermissionStateMap(sectionName, value) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${sectionName} must be an object`);
  for (const [key, state] of Object.entries(value)) {
    assert(typeof key === "string" && key.length > 0, `${sectionName} contains an empty key`);
    assert(permissionStates.has(state), `${sectionName}.${key} must be one of allow, deny, ask`);
  }
}

function validateDefaultPolicy(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "defaultPolicy must be an object");
  for (const key of ["tools", "bash", "mcp", "skills", "special"]) {
    assert(permissionStates.has(value[key]), `defaultPolicy.${key} must be one of allow, deny, ask`);
  }
}

function validatePolicyExample(config) {
  validateDefaultPolicy(config.defaultPolicy);
  for (const section of ["tools", "bash", "mcp", "skills", "special"]) {
    if (config[section] !== undefined) {
      validatePermissionStateMap(section, config[section]);
    }
  }
}

const extensionConfig = readJson("config.json");
assert(extensionConfig && typeof extensionConfig === "object" && !Array.isArray(extensionConfig), "config.json must be an object");

const schema = readJson("schemas/permissions.schema.json");
const specialProperties = schema?.properties?.special?.properties;
assert(specialProperties && typeof specialProperties === "object", "schema special properties must be present");
assert(!Object.prototype.hasOwnProperty.call(specialProperties, "tool_call_limit"), "schema must not expose unsupported special.tool_call_limit");
assert(Object.prototype.hasOwnProperty.call(specialProperties, "external_directory"), "schema must expose special.external_directory");

validatePolicyExample(readJson("config/config.example.json"));

const packageJson = readJson("package.json");
assert(packageJson.scripts?.typecheck?.includes("tsc"), "package.json must expose a TypeScript typecheck script");
assert(!packageJson.scripts?.build?.includes("--noCheck"), "package.json build must not disable TypeScript checks");
assert(typeof packageJson.engines?.bun === "string", "package.json engines must document the Bun test requirement");

const readme = readFileSync(join(root, "README.md"), "utf8");
assert(!readme.includes("tool_call_limit"), "README must not document unsupported special.tool_call_limit");
assert(readme.includes("npm run validate:artifacts"), "README development commands must include artifact validation");

console.log("Artifact validation passed.");
