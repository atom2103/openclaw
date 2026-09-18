import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { buildCodexPluginThreadConfig } from "./plugin-thread-config.js";
import { appInfo, pluginInstalled, pluginList } from "./plugin-thread-config.test-helpers.js";
import type { CodexAppServerRequestParams } from "./protocol.js";
import { readPluginAppPolicyContext } from "./session-binding-record.js";

describe("warm native tool metadata recovery", () => {
  it("recovers on the first rebuild of the loaded fallback thread and still denies writes", async () => {
    const fixture = recoveryFixture();
    const fallback = await fixture.build();
    expect(fallback.configPatch?.apps).toMatchObject({
      drive: {
        default_tools_enabled: false,
        tools: { "drive.fetch": { enabled: false }, "drive.create": { enabled: false } },
      },
    });
    expect(fallback.policyContext.apps.drive).toMatchObject({ nativeToolMetadataFallback: true });
    const persisted = readPluginAppPolicyContext(
      JSON.parse(JSON.stringify(fallback.policyContext)),
      2,
    );
    expect(persisted).toEqual(fallback.policyContext);
    fixture.state.metadataReady = true;
    const recovered = await fixture.build({ threadId: "loaded", previousPolicyContext: persisted });
    expect(recovered.inputFingerprint).toBe(fallback.inputFingerprint);
    expect(recovered.configPatch?.apps).toMatchObject({
      drive: {
        enabled: true,
        destructive_enabled: false,
        tools: { "drive.create": { enabled: false } },
      },
    });
    expect(recovered.policyContext.apps.drive.nativeToolMetadataFallback).toBeUndefined();
    expect(recovered.configPatch).not.toHaveProperty(["apps", "drive", "default_tools_enabled"]);
    expect(recovered.configPatch).not.toHaveProperty(["apps", "drive", "tools", "drive.fetch"]);
    expect(recovered.fingerprint).not.toBe(fallback.fingerprint);
    expect(recovered.provisionalAppIds).toContain("drive");
  });

  it("keeps the fallback and provenance when native metadata is still unavailable", async () => {
    const fixture = recoveryFixture();
    const fallback = await fixture.build();
    const retried = await fixture.build({
      threadId: "loaded",
      previousPolicyContext: fallback.policyContext,
    });
    expect(retried.configPatch).toEqual(fallback.configPatch);
    expect(retried.policyContext).toEqual(fallback.policyContext);
  });

  it.each([
    "unmarked",
    "global-disabled",
    "global-uncallable",
    "native-denied",
    "inaccessible",
    "allowlist",
  ] as const)("preserves %s denial during recovery", async (denial) => {
    const fixture = recoveryFixture();
    const fallback = await fixture.build();
    fixture.state.metadataReady = true;
    if (denial === "global-disabled") fixture.state.globalEnabled = false;
    if (denial === "global-uncallable") fixture.state.globalCallable = false;
    if (denial === "native-denied") fixture.state.saved = { enabled: false };
    if (denial === "inaccessible") fixture.state.accessible = false;
    if (denial === "allowlist") fixture.state.allowAll = false;
    const result = await fixture.build({
      threadId: "loaded",
      previousPolicyContext: denial === "unmarked" ? undefined : fallback.policyContext,
    });
    expect(result.policyContext.apps).toEqual({});
    expect(result.configPatch?.apps).toMatchObject({ _default: { enabled: false } });
  });

  it("does not enable saved disabled defaults or read tools while recovering", async () => {
    const fixture = recoveryFixture();
    const fallback = await fixture.build();
    fixture.state.metadataReady = true;
    fixture.state.saved = {
      default_tools_enabled: false,
      tools: { "drive.fetch": { enabled: false } },
    };
    const result = await fixture.build({
      threadId: "loaded",
      previousPolicyContext: fallback.policyContext,
    });
    expect(result.policyContext.apps.drive).toMatchObject({ allowDestructiveActions: false });
    expect(result.configPatch).toHaveProperty(["apps", "drive"], {
      enabled: true,
      destructive_enabled: false,
      open_world_enabled: true,
      default_tools_approval_mode: "auto",
      tools: { "drive.create": { enabled: false } },
    });
    expect(fixture.state.saved).toEqual({
      default_tools_enabled: false,
      tools: { "drive.fetch": { enabled: false } },
    });
  });
});

function recoveryFixture() {
  const state = {
    metadataReady: false,
    globalEnabled: true,
    globalCallable: true,
    accessible: true,
    allowAll: true,
    saved: {
      default_tools_enabled: true,
      tools: {
        "drive.fetch": { enabled: true, approval_mode: "approve" },
        "drive.create": { enabled: true, approval_mode: "approve" },
      },
    } as Record<string, unknown>,
  };
  const request = vi.fn(async (method: string, input?: unknown) => {
    if (method === "plugin/installed") return pluginInstalled([]);
    if (method === "plugin/list") return pluginList([]);
    if (method === "app/installed" || method === "app/read") {
      const params = input as CodexAppServerRequestParams<"app/read">;
      return codexAppInventoryResponse(
        method,
        [appInfo("drive", state.accessible, params?.threadId ? true : state.globalEnabled)],
        params,
        { callableByAppId: { drive: params?.threadId ? false : state.globalCallable } },
      );
    }
    if (method === "config/read")
      return {
        config: { apps: { drive: state.saved } },
        layers: [{ name: { type: "user" }, config: { apps: { drive: state.saved } } }],
      };
    if (method === "mcpServerStatus/list") {
      if (!state.metadataReady) throw new Error("native metadata temporarily unavailable");
      return {
        data: [
          {
            name: "codex_apps",
            tools: {
              "drive.fetch": {
                name: "drive.fetch",
                annotations: { readOnlyHint: true },
                _meta: { connector_id: "drive" },
              },
              "drive.create": {
                name: "drive.create",
                annotations: { readOnlyHint: false },
                _meta: { connector_id: "drive" },
              },
            },
          },
        ],
        nextCursor: null,
      };
    }
    throw new Error(`Unexpected request ${method}`);
  });
  const appCache = new CodexAppInventoryCache();
  const build = (options: Partial<Parameters<typeof buildCodexPluginThreadConfig>[0]> = {}) =>
    buildCodexPluginThreadConfig({
      request,
      appCache,
      appCacheKey: "runtime",
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: state.allowAll,
          allow_destructive_actions: false,
          plugins: {},
        },
      },
      ...options,
    });
  return { state, request, build };
}
