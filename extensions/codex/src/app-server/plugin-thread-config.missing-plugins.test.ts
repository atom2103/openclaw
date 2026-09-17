import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import { buildCodexPluginThreadConfig } from "./plugin-thread-config.js";
import {
  appInfo,
  appSummary,
  pluginDetail,
  pluginInstalled,
  pluginList,
  pluginSummary,
} from "./plugin-thread-config.test-helpers.js";

describe("missing Codex plugin permissions", () => {
  beforeEach(() => defaultCodexAppInventoryCache.clear());
  it.each(
    [
      {
        name: "an enabled plugin is missing",
        marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
        diagnosticCode: "plugin_missing",
      },
      {
        name: "an enabled plugin's marketplace is missing",
        marketplaceName: "missing-marketplace",
        diagnosticCode: "marketplace_missing",
      },
    ].flatMap((scenario) =>
      ["auto", false, "ask"].flatMap((restriction) =>
        [[], ["unrelated-display-name"]].map((pluginDisplayNames) => ({
          ...scenario,
          restriction,
          pluginDisplayNames,
          destructiveEnabled: restriction !== false,
          approvalMode: restriction === false ? "deny" : restriction,
        })),
      ),
    ),
  )(
    "preserves $restriction policy with owner names $pluginDisplayNames when $name",
    async ({
      marketplaceName,
      diagnosticCode,
      restriction,
      pluginDisplayNames,
      destructiveEnabled,
      approvalMode,
    }) => {
      const errorLog = vi.spyOn(embeddedAgentLog, "error").mockImplementation(() => {});
      try {
        const request = vi.fn(async (method: string) => {
          if (method === "app/installed" || method === "app/read") {
            return codexAppInventoryResponse(method, [
              appInfo("configured-app", true),
              { ...appInfo("account-calendar-app", true), pluginDisplayNames },
            ]);
          }
          if (method === "plugin/installed" || method === "plugin/list") {
            const summaries = [pluginSummary("healthy-plugin", { installed: true, enabled: true })];
            return method === "plugin/installed"
              ? pluginInstalled(summaries)
              : pluginList(summaries);
          }
          if (method === "plugin/read") {
            return pluginDetail("healthy-plugin", [appSummary("configured-app")]);
          }
          if (method === "config/read") {
            return { config: {}, layers: [] };
          }
          throw new Error(`unexpected request ${method}`);
        });
        const config = await buildCodexPluginThreadConfig({
          pluginConfig: {
            codexPlugins: {
              enabled: true,
              allow_all_plugins: true,
              allow_destructive_actions: "auto",
              plugins: {
                healthy: {
                  marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                  pluginName: "healthy-plugin",
                  allow_destructive_actions: "auto",
                },
                missing: {
                  marketplaceName,
                  pluginName: "missing-plugin",
                  allow_destructive_actions: restriction,
                },
              },
            },
          },
          appCacheKey: "runtime",
          request,
        });

        expect(config.configPatch?.apps).toMatchObject({
          "configured-app": { enabled: true, destructive_enabled: true },
          "account-calendar-app": {
            enabled: true,
            destructive_enabled: destructiveEnabled,
            ...(restriction === "ask" ? { approvals_reviewer: "user" } : {}),
          },
        });
        expect(config.policyContext.apps).toMatchObject({
          "configured-app": {
            configKey: "healthy",
            allowDestructiveActions: true,
            destructiveApprovalMode: "auto",
          },
          "account-calendar-app": {
            source: "account",
            allowDestructiveActions: destructiveEnabled,
            destructiveApprovalMode: approvalMode,
          },
        });
        expect(config.diagnostics).toEqual([
          expect.objectContaining({
            code: diagnosticCode,
            plugin: expect.objectContaining({ configKey: "missing" }),
          }),
        ]);
        expect(errorLog).toHaveBeenCalledExactlyOnceWith(config.diagnostics[0]?.message, {
          code: diagnosticCode,
          configKey: "missing",
          pluginName: "missing-plugin",
          marketplaceName,
        });
      } finally {
        errorLog.mockRestore();
      }
    },
  );
});
