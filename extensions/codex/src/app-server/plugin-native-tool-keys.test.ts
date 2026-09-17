import { describe, expect, it, vi } from "vitest";
import { buildCodexAppApprovalOverrides } from "./plugin-app-approval-overrides.js";
import {
  readCodexNativeAppToolKeys,
  withCodexNativeAppToolKeys,
} from "./plugin-native-tool-keys.js";

describe("native app policy keys", () => {
  it("uses exact names and ownership across pages before projecting saved overrides", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            name: "codex_apps",
            tools: {
              read: {
                name: "drive.fetch",
                annotations: { readOnlyHint: true },
                _meta: { connector_id: "drive" },
              },
              other: {
                name: "calendar.create",
                annotations: { readOnlyHint: false },
                _meta: { connector_id: "calendar" },
              },
            },
          },
        ],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        data: [
          {
            name: "codex_apps",
            tools: {
              write: {
                name: "drive.create_folder",
                title: "Create folder",
                annotations: { readOnlyHint: false },
                _meta: { connector_id: "drive" },
              },
            },
          },
        ],
        nextCursor: null,
      });
    const keys = await readCodexNativeAppToolKeys(request);
    expect(request.mock.calls).toEqual([
      ["mcpServerStatus/list", { detail: "toolsAndAuthOnly" }],
      ["mcpServerStatus/list", { detail: "toolsAndAuthOnly", cursor: "next" }],
    ]);
    expect(keys?.get("drive")).toEqual(["Create folder", "drive.create_folder"]);
    const app = withCodexNativeAppToolKeys(
      { id: "drive", approvalOverrideToolConfigKeys: ["create_folder"] },
      keys,
    );
    const config = {
      apps: {
        drive: {
          default_tools_enabled: true,
          tools: {
            "drive.create_folder": { enabled: true, approval_mode: "approve" },
            "drive.fetch": { enabled: true, approval_mode: "approve" },
          },
        },
      },
    };
    const saved = structuredClone(config);
    expect(buildCodexAppApprovalOverrides(config, app, "deny")).toEqual({
      tools: {
        "Create folder": { enabled: false },
        create_folder: { enabled: false },
        "drive.create_folder": { enabled: false, approval_mode: "auto" },
      },
    });
    expect(buildCodexAppApprovalOverrides(config, app, "ask")).toEqual({
      tools: {
        "drive.create_folder": { approval_mode: "auto" },
      },
    });
    expect(config).toEqual(saved);
  });

  it("treats missing read-only hints conservatively and keeps read-only app inventory known", async () => {
    const keys = await readCodexNativeAppToolKeys(async () => ({
      data: [
        {
          name: "codex_apps",
          tools: {
            unknown: { name: "drive.unknown", _meta: { connector_id: "drive" } },
            read: {
              name: "calendar.read",
              annotations: { readOnlyHint: true },
              _meta: { connector_id: "calendar" },
            },
          },
        },
      ],
      nextCursor: null,
    }));
    expect(keys?.get("drive")).toEqual(["drive.unknown"]);
    expect(keys?.get("calendar")).toEqual([]);
  });

  it.each([
    { data: [], nextCursor: "repeated" },
    { data: [{ name: "codex_apps", tools: { malformed: { name: "unknown" } } }] },
    { data: [{ name: "codex_apps", tools: null }] },
    {},
  ])("does not trust incomplete or malformed native inventory: %j", async (response) => {
    expect(await readCodexNativeAppToolKeys(async () => response)).toBeUndefined();
  });

  it("drops alias-only scope on RPC failure or absent app so saved settings cannot bypass fallback", async () => {
    const keys = await readCodexNativeAppToolKeys(async () => {
      throw new Error("unavailable");
    });
    const app = { id: "drive", approvalOverrideToolConfigKeys: ["create_folder"] };
    for (const inventory of [keys, new Map<string, string[]>()]) {
      const resolved = withCodexNativeAppToolKeys(app, inventory);
      expect(resolved.approvalOverrideToolConfigKeys).toBeUndefined();
      expect(
        buildCodexAppApprovalOverrides(
          {
            apps: {
              drive: {
                tools: {
                  "drive.create_folder": { enabled: true, approval_mode: "approve" },
                },
              },
            },
          },
          resolved,
          "ask",
        ),
      ).toEqual({
        tools: {
          "drive.create_folder": { approval_mode: "auto" },
        },
      });
      expect(
        buildCodexAppApprovalOverrides(
          {
            apps: {
              drive: {
                tools: {
                  "drive.create_folder": { enabled: true, approval_mode: "approve" },
                },
              },
            },
          },
          resolved,
          "deny",
        ),
      ).toEqual({
        default_tools_enabled: false,
        tools: {
          "drive.create_folder": { enabled: false, approval_mode: "auto" },
        },
      });
    }
  });
});
