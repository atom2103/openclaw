import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import type { PluginAppPolicyContext } from "./plugin-app-policy-context.js";
import type { CodexPluginRuntimeRequest } from "./plugin-inventory.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

/** Recheck only restrictions installed by our own missing-metadata fallback. */
export function withCodexMetadataRecovery<
  T extends {
    request: CodexPluginRuntimeRequest;
    threadId?: string;
    previousPolicyContext?: PluginAppPolicyContext;
  },
>(params: T): T {
  const marked = new Set(
    Object.entries(params.previousPolicyContext?.apps ?? {})
      .filter(([, app]) => app.nativeToolMetadataFallback && !app.allowDestructiveActions)
      .map(([id]) => id),
  );
  if (!params.threadId || marked.size === 0) {
    return params;
  }
  const request: CodexPluginRuntimeRequest = async (method, input) => {
    const scoped = await params.request(method, input);
    if (
      method !== "app/installed" ||
      !isJsonObject(input) ||
      input.threadId !== params.threadId ||
      !isJsonObject(scoped) ||
      !Array.isArray(scoped.apps)
    ) {
      return scoped;
    }
    const candidates = scoped.apps.filter(
      (app) =>
        isJsonObject(app) &&
        typeof app.id === "string" &&
        marked.has(app.id) &&
        app.enabled === true &&
        app.callable === false,
    );
    if (candidates.length === 0) {
      return scoped;
    }
    const globalInput: JsonObject = { ...input, forceRefresh: true };
    delete globalInput.threadId;
    const global = await params.request(method, globalInput);
    if (!isJsonObject(global) || !Array.isArray(global.apps)) {
      throw new Error("Cannot verify native app availability for metadata recovery");
    }
    const ready = new Set(
      global.apps.flatMap((app) =>
        isJsonObject(app) &&
        typeof app.id === "string" &&
        app.enabled === true &&
        app.callable === true
          ? [app.id]
          : [],
      ),
    );
    const apps = scoped.apps.slice();
    for (const [index, app] of apps.entries()) {
      if (
        candidates.includes(app) &&
        isJsonObject(app) &&
        typeof app.id === "string" &&
        ready.has(app.id)
      ) {
        apps[index] = { ...app, callable: true };
      }
    }
    return { ...scoped, apps };
  };
  // Avoid reusing the thread's cached fallback inventory. This only permits a
  // policy rebuild: current authorization, native tool restrictions and fresh
  // thread attestation still apply before any tool can execute.
  return { ...params, request, appCache: new CodexAppInventoryCache() };
}

export function nativeMetadataFallbackContext(
  policy: { allowDestructiveActions: boolean },
  keys: Map<string, string[]> | undefined,
  appId: string,
): { nativeToolMetadataFallback?: true } {
  return !policy.allowDestructiveActions && !keys?.has(appId)
    ? { nativeToolMetadataFallback: true }
    : {};
}
