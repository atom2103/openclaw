import type { CodexPluginOwnedApp } from "./plugin-inventory.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

/** Projects action restrictions into the native session layer without changing saved settings. */
export function buildCodexAppApprovalOverrides(
  config: Record<string, unknown>,
  app: Pick<CodexPluginOwnedApp, "id" | "approvalOverrideToolConfigKeys">,
  mode: "ask" | "deny" = "ask",
): JsonObject {
  const appsRoot = config.apps;
  const appConfig = isJsonObject(appsRoot) ? appsRoot[app.id] : undefined;
  const overrides: JsonObject = {};
  const keys = app.approvalOverrideToolConfigKeys;
  if (mode === "deny") {
    // Native per-tool enablement precedes destructive hints. Deny every current
    // writable alias, including title collisions, even without saved settings.
    // Missing metadata cannot establish a safe read-only subset.
    const savedTools =
      isJsonObject(appConfig) && isJsonObject(appConfig.tools) ? appConfig.tools : {};
    const deniedKeys = keys ?? Object.keys(savedTools);
    overrides.tools = Object.fromEntries(deniedKeys.map((key) => [key, { enabled: false }]));
    if (!keys) {
      overrides.default_tools_enabled = false;
    }
  }
  if (!isJsonObject(appConfig)) {
    return overrides;
  }
  if (mode === "deny" && !keys && isJsonObject(appConfig.links)) {
    overrides.links = Object.fromEntries(
      Object.entries(appConfig.links)
        .filter(([, link]) => isJsonObject(link))
        .map(([name]) => [name, { default_tools_enabled: false }]),
    );
  }
  // Link and tool policy outrank app defaults. Session overlays survive native
  // user-config reloads; durable writes cannot acknowledge every loaded thread.
  for (const [section, fields] of [
    ["tools", { approval_mode: "auto" }],
    ["links", { approvals_reviewer: "user", default_tools_approval_mode: "auto" }],
  ] as const) {
    const entries = appConfig[section];
    if (!isJsonObject(entries)) {
      continue;
    }
    const projected: Array<[string, JsonObject]> = [];
    for (const [name, value] of Object.entries(entries).toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!isJsonObject(value) || (section === "tools" && keys && !keys.includes(name))) {
        continue;
      }
      if (
        Object.keys(fields).some((field) => value[field] !== undefined && value[field] !== null)
      ) {
        // Merge only approval fields, preserving native disabled tools and other settings.
        projected.push([name, fields]);
      }
    }
    if (projected.length > 0) {
      const existing = isJsonObject(overrides[section]) ? overrides[section] : {};
      overrides[section] = Object.fromEntries([
        ...Object.entries(existing),
        ...projected.map(([name, fields]) => [
          name,
          Object.assign({}, fields, isJsonObject(existing[name]) ? existing[name] : {}),
        ]),
      ]);
    }
  }
  return overrides;
}
