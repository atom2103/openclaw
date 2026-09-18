import { describe, expect, it } from "vitest";
import { createStoredCodexAppServerBinding } from "./session-binding.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";

describe("Codex app-server binding policy context", () => {
  it.each([false, true])(
    "round-trips account app policy context with metadata fallback %s",
    async (fallback) => {
      const store = createCodexTestBindingStore();
      const identity = { kind: "session" as const, agentId: "main", sessionId: "session-account" };
      const pluginAppPolicyContext = {
        fingerprint: "account-policy-1",
        apps: {
          "chatgpt-meetings": {
            source: "account" as const,
            appName: "ChatGPT Meetings",
            ...(fallback ? { nativeToolMetadataFallback: true as const } : {}),
            allowDestructiveActions: true,
            allowOpenWorld: false,
            destructiveApprovalMode: "auto" as const,
            mcpServerNames: [],
          },
        },
        pluginAppIds: {},
      };

      await store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-account", cwd: "/repo", pluginAppPolicyContext },
      });
      expect(store.read(identity)).toMatchObject({ pluginAppPolicyContext });

      const imported = createStoredCodexAppServerBinding({
        schemaVersion: 2,
        threadId: "thread-account",
        cwd: "/repo",
        updatedAt: "2026-01-01T00:00:00.000Z",
        pluginAppPolicyContext,
      });
      expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
    },
  );

  it.each([false, true])(
    "round-trips repository marketplace app ownership with metadata fallback %s",
    async (fallback) => {
      const store = createCodexTestBindingStore();
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "session-security-review",
      };
      const pluginAppPolicyContext = {
        fingerprint: "repository-plugin-policy",
        apps: {
          github: {
            configKey: "security-review@company-tools",
            marketplaceName: "company-tools",
            pluginName: "security-review",
            ...(fallback ? { nativeToolMetadataFallback: true as const } : {}),
            allowDestructiveActions: true,
            destructiveApprovalMode: "ask" as const,
            mcpServerNames: ["github"],
          },
        },
        pluginAppIds: { "security-review@company-tools": ["github"] },
      };

      await store.mutate(identity, {
        kind: "set",
        binding: {
          threadId: "thread-security-review",
          cwd: "/repo/company",
          pluginAppPolicyContext,
        },
      });
      expect(store.read(identity)).toMatchObject({ pluginAppPolicyContext });

      const imported = createStoredCodexAppServerBinding({
        schemaVersion: 2,
        threadId: "thread-security-review",
        cwd: "/repo/company",
        pluginAppPolicyContext,
      });
      expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
    },
  );
});
