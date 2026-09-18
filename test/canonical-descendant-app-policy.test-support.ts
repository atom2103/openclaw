import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";

const savedApp = {
  enabled: true,
  default_tools_enabled: true,
  tools: {
    "synthetic.fetch": { enabled: true, approval_mode: "approve" },
    "synthetic.create": { enabled: true, approval_mode: "approve" },
  },
};

export function response(method: string) {
  if (method === "config/read") {
    return { config: { apps: { "synthetic-app": savedApp } }, origins: {}, layers: [] };
  }
  if (method === "mcpServerStatus/list") {
    return {
      data: [
        {
          name: "codex_apps",
          tools: {
            read: {
              name: "synthetic.fetch",
              annotations: { readOnlyHint: true },
              _meta: { connector_id: "synthetic-app" },
            },
            write: {
              name: "synthetic.create",
              annotations: { readOnlyHint: false, destructiveHint: true },
              _meta: { connector_id: "synthetic-app" },
            },
          },
        },
      ],
      nextCursor: null,
    };
  }
  return undefined;
}

export function expectOverlay(config: unknown, context: unknown) {
  expect(context).toMatchObject({
    apps: { "synthetic-app": { source: "account", allowDestructiveActions: false } },
  });
  const apps = isRecord(config) && isRecord(config.apps) ? config.apps : {};
  const app = isRecord(apps["synthetic-app"]) ? apps["synthetic-app"] : {};
  expect(app).toMatchObject({ enabled: true, destructive_enabled: false });
  // Evaluate the emitted session overlay over the account preferences supplied
  // by config/read. App admission alone does not prove its read tool stays usable.
  const effective = {
    ...savedApp,
    ...app,
    tools: { ...savedApp.tools, ...(isRecord(app.tools) ? app.tools : {}) },
  };
  expect(effective).toMatchObject({
    enabled: true,
    default_tools_enabled: true,
    tools: {
      "synthetic.fetch": { enabled: true, approval_mode: "approve" },
      "synthetic.create": { enabled: false, approval_mode: "auto" },
    },
  });
}

export function expectedFallbackContext(appPolicy: string) {
  if (appPolicy === "unconfigured") {
    return undefined;
  }
  if (appPolicy !== "enabled") {
    return {};
  }
  return {
    "synthetic-app": {
      source: "account",
      appName: "Synthetic App",
      allowDestructiveActions: false,
      nativeToolMetadataFallback: true,
      allowOpenWorld: true,
      destructiveApprovalMode: "deny",
      mcpServerNames: [],
    },
  };
}
