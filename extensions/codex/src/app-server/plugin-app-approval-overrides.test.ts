import { describe, expect, it } from "vitest";
import { buildCodexAppApprovalOverrides } from "./plugin-app-approval-overrides.js";

describe("native action restriction overlays", () => {
  const app = { id: "fixture", approvalOverrideToolConfigKeys: ["write", "Write record"] };

  it("overrides saved writable enablement without rewriting saved settings or read policy", () => {
    const saved = {
      apps: {
        fixture: {
          default_tools_enabled: true,
          tools: {
            write: { enabled: true, approval_mode: "approve" },
            read: { enabled: false, approval_mode: "approve" },
          },
          links: {
            account: { approvals_reviewer: "guardian", default_tools_approval_mode: "approve" },
          },
        },
      },
    };
    const before = structuredClone(saved);
    expect(buildCodexAppApprovalOverrides(saved, app, "deny")).toEqual({
      tools: {
        write: { enabled: false, approval_mode: "auto" },
        "Write record": { enabled: false },
      },
      links: { account: { approvals_reviewer: "user", default_tools_approval_mode: "auto" } },
    });
    expect(saved).toEqual(before);
  });

  it("denies current writable aliases even before native overrides exist", () => {
    expect(buildCodexAppApprovalOverrides({}, app, "deny")).toEqual({
      tools: { write: { enabled: false }, "Write record": { enabled: false } },
    });
  });

  it("disables defaults and saved tools when metadata cannot identify reads", () => {
    expect(
      buildCodexAppApprovalOverrides(
        { apps: { fixture: { tools: { unknown: { enabled: true, approval_mode: "approve" } } } } },
        { id: "fixture" },
        "deny",
      ),
    ).toEqual({
      default_tools_enabled: false,
      tools: { unknown: { enabled: false, approval_mode: "auto" } },
    });
  });

  it("disables permissive saved link defaults when metadata is absent", () => {
    expect(
      buildCodexAppApprovalOverrides(
        { apps: { fixture: { links: { account: { default_tools_enabled: true } } } } },
        { id: "fixture" },
        "deny",
      ),
    ).toEqual({
      tools: {},
      default_tools_enabled: false,
      links: { account: { default_tools_enabled: false } },
    });
  });

  it("distinguishes a verified read-only inventory from absent metadata", () => {
    expect(
      buildCodexAppApprovalOverrides(
        {},
        { id: "fixture", approvalOverrideToolConfigKeys: [] },
        "deny",
      ),
    ).toEqual({ tools: {} });
    expect(buildCodexAppApprovalOverrides({}, { id: "fixture" }, "deny")).toEqual({
      tools: {},
      default_tools_enabled: false,
    });
  });
});
