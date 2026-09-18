import type { CodexPluginDestructiveApprovalMode, ResolvedCodexPluginPolicy } from "./config.js";

/** Policy context for one app id exposed by a configured Codex plugin. */
export type PluginAppPolicyContextEntry = {
  source?: "plugin";
  configKey: string;
  marketplaceName: ResolvedCodexPluginPolicy["marketplaceName"];
  pluginName: string;
  allowDestructiveActions: boolean;
  nativeToolMetadataFallback?: true;
  allowOpenWorld?: boolean;
  destructiveApprovalMode?: CodexPluginDestructiveApprovalMode;
  mcpServerNames: string[];
};

/** Policy context for one account-connected app admitted without a plugin package. */
type AccountAppPolicyContextEntry = {
  source: "account";
  appName: string;
  allowDestructiveActions: boolean;
  nativeToolMetadataFallback?: true;
  allowOpenWorld?: boolean;
  destructiveApprovalMode?: CodexPluginDestructiveApprovalMode;
  mcpServerNames: string[];
};

/** Policy context for any app exposed to a native Codex thread. */
export type CodexAppPolicyContextEntry = PluginAppPolicyContextEntry | AccountAppPolicyContextEntry;

/** Stable app-to-plugin ownership context persisted with Codex thread bindings. */
export type PluginAppPolicyContext = {
  fingerprint: string;
  apps: Record<string, CodexAppPolicyContextEntry>;
  pluginAppIds: Record<string, string[]>;
};
