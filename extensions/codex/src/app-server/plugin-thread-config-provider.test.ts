import { describe, expect, it, vi } from "vitest";
import { createCodexPluginThreadConfigStartupProvider } from "./plugin-thread-config-deadline.js";
import {
  buildCodexPluginThreadConfig,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";

vi.mock("./plugin-thread-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-thread-config.js")>()),
  buildCodexPluginThreadConfig: vi.fn(),
}));

describe("plugin config startup provider", () => {
  it("preserves loaded-thread fallback provenance through the bounded builder", async () => {
    const config: CodexPluginThreadConfig = {
      enabled: true,
      fingerprint: "fallback-config",
      inputFingerprint: "fallback-input",
      diagnostics: [],
      policyContext: {
        fingerprint: "fallback-policy",
        apps: {
          drive: {
            source: "account",
            appName: "Drive",
            allowDestructiveActions: false,
            destructiveApprovalMode: "deny",
            nativeToolMetadataFallback: true,
            mcpServerNames: [],
          },
        },
        pluginAppIds: {},
      },
    };
    vi.mocked(buildCodexPluginThreadConfig).mockResolvedValue(config);
    const provider = createCodexPluginThreadConfigStartupProvider({
      inputFingerprint: config.inputFingerprint,
      enabledPluginConfigKeys: undefined,
      policy: undefined,
      requestTimeoutMs: 10_000,
      signal: new AbortController().signal,
      client: { request: vi.fn() },
      appCacheKey: "provider-provenance",
    });

    await expect(
      provider.build({
        threadId: "loaded-thread",
        previousPolicyContext: config.policyContext,
      }),
    ).resolves.toBe(config);

    expect(buildCodexPluginThreadConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "loaded-thread",
        previousPolicyContext: config.policyContext,
      }),
    );
  });
});
