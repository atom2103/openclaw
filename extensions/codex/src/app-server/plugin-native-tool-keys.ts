import type { CodexPluginOwnedApp, CodexPluginRuntimeRequest } from "./plugin-inventory.js";
import { isJsonObject } from "./protocol.js";

/** Read authoritative native policy keys; app/read names can omit the tool namespace. */
export async function readCodexNativeAppToolKeys(
  request: CodexPluginRuntimeRequest,
): Promise<Map<string, string[]> | undefined> {
  const keys = new Map<string, Set<string>>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const result = await request("mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
        ...(cursor ? { cursor } : {}),
      });
      if (!isJsonObject(result) || !Array.isArray(result.data)) {
        return undefined;
      }
      for (const server of result.data) {
        if (!isJsonObject(server) || server.name !== "codex_apps") {
          continue;
        }
        if (!isJsonObject(server.tools)) {
          return undefined;
        }
        for (const tool of Object.values(server.tools)) {
          if (!isJsonObject(tool) || typeof tool.name !== "string" || !tool.name) {
            return undefined;
          }
          const meta = tool._meta;
          const appId = isJsonObject(meta) ? meta.connector_id : undefined;
          if (typeof appId !== "string" || !appId || !tool.name) {
            return undefined;
          }
          const appKeys = keys.get(appId) ?? new Set<string>();
          keys.set(appId, appKeys);
          if (!isJsonObject(tool.annotations) || tool.annotations.readOnlyHint !== true) {
            appKeys.add(tool.name);
            if (typeof tool.title === "string" && tool.title) {
              appKeys.add(tool.title);
            }
          }
        }
      }
      if (result.nextCursor != null && typeof result.nextCursor !== "string") {
        return undefined;
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) {
        return undefined;
      }
      if (cursor) {
        cursors.add(cursor);
      }
    } while (cursor);
    return new Map([...keys].map(([id, names]) => [id, [...names].toSorted()]));
  } catch {
    // Unknown native keys must not preserve permissive saved overrides.
    return undefined;
  }
}

export function withCodexNativeAppToolKeys(
  app: Pick<CodexPluginOwnedApp, "id" | "approvalOverrideToolConfigKeys">,
  nativeKeys: Map<string, string[]> | undefined,
): Pick<CodexPluginOwnedApp, "id" | "approvalOverrideToolConfigKeys"> {
  const keys = nativeKeys?.get(app.id);
  return {
    id: app.id,
    approvalOverrideToolConfigKeys: keys
      ? [...new Set([...keys, ...(app.approvalOverrideToolConfigKeys ?? [])])].toSorted()
      : undefined,
  };
}
