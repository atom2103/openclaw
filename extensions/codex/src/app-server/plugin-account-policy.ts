import type { ResolvedCodexPluginsPolicy } from "./config.js";
import type { CodexPluginInventoryDiagnostic } from "./plugin-inventory.js";

export function resolveCodexAccountAppPolicy(
  policy: ResolvedCodexPluginsPolicy,
  diagnostics: readonly CodexPluginInventoryDiagnostic[],
): ResolvedCodexPluginsPolicy {
  const accountPolicy = { ...policy };
  for (const diagnostic of diagnostics) {
    const missing = diagnostic.plugin;
    if (
      !missing?.enabled ||
      (diagnostic.code !== "plugin_missing" && diagnostic.code !== "marketplace_missing")
    ) {
      continue;
    }
    // Unknown ownership cannot turn a plugin restriction into broader account
    // authority. Keep reads available and retain the strictest action policy;
    // proven configured apps already received their own policy above.
    if (!missing.allowDestructiveActions) {
      accountPolicy.allowDestructiveActions = false;
      accountPolicy.destructiveApprovalMode = "deny";
    } else if (missing.destructiveApprovalMode === "ask" && accountPolicy.allowDestructiveActions) {
      accountPolicy.destructiveApprovalMode = "ask";
    }
  }
  return accountPolicy;
}
