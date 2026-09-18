import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "../../../extensions/codex/test-api.js";
import { getBeforeToolCallDiagnosticOptions } from "../../agents/before-tool-call-metadata.js";
import { asToolParamsRecord, type AnyAgentTool } from "../../agents/tools/common.js";
import { hasInternalDiagnosticEventInterest } from "../../infra/diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent,
  emitTrustedSkillUsedDiagnosticEvent,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { consumeRunSkillUsage } from "../runtime/run-usage.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import { registerSkillUsageTracking } from "./curator.js";

let testState: OpenClawTestState;

beforeEach(async () => {
  resetDiagnosticEventsForTest();
  testState = await createOpenClawTestState({
    layout: "home",
    prefix: "openclaw-skill-curator-",
  });
});

afterEach(async () => {
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  await testState.cleanup();
});

describe("skill curator usage tracking", () => {
  it("persists trusted skill usage by absolute file identity and increments repeated use", async () => {
    const database = openOpenClawStateDatabase({ env: testState.env });
    const skillFile = testState.path("skills", "daily-brief", "SKILL.md");
    const unregister = registerSkillUsageTracking({ env: testState.env });
    expect(hasInternalDiagnosticEventInterest("skill.used")).toBe(true);
    expect(hasInternalDiagnosticEventInterest("gateway.rpc")).toBe(false);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const event = {
      type: "skill.used",
      skillName: "Daily Brief",
      skillSource: "workspace",
      activation: "read",
      agentId: "first-agent",
    } as const;

    emitTrustedSkillUsedDiagnosticEvent(event, { skillUsage: { skillFile } });
    await waitForDiagnosticEventsDrained();

    expect(
      database.db
        .prepare(
          "SELECT first_used_at_ms, last_used_at_ms, use_count, last_agent_id FROM skill_usage WHERE skill_file = ?",
        )
        .get(skillFile),
    ).toEqual({
      first_used_at_ms: 1_000,
      last_used_at_ms: 1_000,
      use_count: 1,
      last_agent_id: "first-agent",
    });

    now.mockReturnValue(2_000);
    emitTrustedSkillUsedDiagnosticEvent(
      { ...event, agentId: "second-agent" },
      { skillUsage: { skillFile } },
    );
    emitTrustedSkillUsedDiagnosticEvent(event, {
      skillUsage: { skillFile: "skills/relative/SKILL.md" },
    });
    emitDiagnosticEvent({ ...event, skillName: "Untrusted Skill" });
    await waitForDiagnosticEventsDrained();

    expect(
      database.db
        .prepare(
          "SELECT first_used_at_ms, last_used_at_ms, use_count, last_agent_id FROM skill_usage WHERE skill_file = ?",
        )
        .get(skillFile),
    ).toEqual({
      first_used_at_ms: 1_000,
      last_used_at_ms: 2_000,
      use_count: 2,
      last_agent_id: "second-agent",
    });
    expect(database.db.prepare("SELECT count(*) AS count FROM skill_usage").get()).toEqual({
      count: 1,
    });

    now.mockReturnValue(500);
    emitTrustedSkillUsedDiagnosticEvent(
      { ...event, agentId: "earlier-agent" },
      { skillUsage: { skillFile } },
    );
    await waitForDiagnosticEventsDrained();
    expect(
      database.db
        .prepare(
          "SELECT first_used_at_ms, last_used_at_ms, use_count, last_agent_id FROM skill_usage WHERE skill_file = ?",
        )
        .get(skillFile),
    ).toEqual({
      first_used_at_ms: 500,
      last_used_at_ms: 2_000,
      use_count: 3,
      last_agent_id: "second-agent",
    });

    unregister();
    expect(hasInternalDiagnosticEventInterest("skill.used")).toBe(false);
    emitTrustedSkillUsedDiagnosticEvent(event, { skillUsage: { skillFile } });
    await waitForDiagnosticEventsDrained();
    expect(
      database.db.prepare("SELECT use_count FROM skill_usage WHERE skill_file = ?").get(skillFile),
    ).toEqual({ use_count: 3 });
  });

  describe("persistent skill usage through registered Codex dynamic tools", () => {
    const runId = "skill-usage-run";
    const skillName = "daily-brief";
    let skillFile: string;
    let unregisterUsage: () => void;
    let publicEvents: DiagnosticEventPayload[];
    let sharedEvents: DiagnosticEventPayload[];
    let trustedEvents: DiagnosticEventPayload[];

    beforeEach(async () => {
      skillFile = await testState.writeText("skills/daily-brief/SKILL.md", "# Daily brief\n");
      resetGlobalHookRunner();
      setActivePluginRegistry(createEmptyPluginRegistry());
      setDiagnosticsEnabledForProcess(false);
      publicEvents = [];
      sharedEvents = [];
      trustedEvents = [];
      onDiagnosticEvent((event) => publicEvents.push(event));
      onInternalDiagnosticEvent((event) => sharedEvents.push(event));
      onTrustedInternalDiagnosticEvent((event) => trustedEvents.push(event));
      unregisterUsage = registerSkillUsageTracking({ env: testState.env });
    });

    afterEach(async () => {
      await waitForDiagnosticEventsDrained();
      unregisterUsage();
      consumeRunSkillUsage(runId);
      resetGlobalHookRunner();
      setActivePluginRegistry(createEmptyPluginRegistry());
    });

    function createBridge(options: { execute?: AnyAgentTool["execute"]; command?: boolean } = {}) {
      const execute = vi.fn<AnyAgentTool["execute"]>(
        options.execute ??
          (async (_callId, args) => {
            const filePath = asToolParamsRecord(args).path;
            if (typeof filePath !== "string") {
              throw new Error("Expected a file path");
            }
            return {
              content: [{ type: "text", text: await fs.readFile(filePath, "utf8") }],
              details: {},
            };
          }),
      );
      const toolName = options.command ? "daily_brief" : "read";
      const bridge = createCodexDynamicToolBridge({
        tools: [
          {
            name: toolName,
            label: toolName,
            description: "Read a file",
            parameters: Type.Object({ path: Type.String() }),
            execute,
          },
        ],
        signal: new AbortController().signal,
        hookContext: {
          agentId: "main",
          sessionKey: "agent:main:skill-usage",
          sessionId: "skill-usage-session",
          runId,
          workspaceDir: testState.workspaceDir,
          loopDetection: { enabled: false },
          skillsSnapshot: {
            prompt: "",
            skills: [{ name: skillName }],
            resolvedSkills: [
              createCanonicalFixtureSkill({
                name: skillName,
                description: "Daily brief",
                filePath: skillFile,
                baseDir: path.dirname(skillFile),
                source: "workspace",
              }),
            ],
          },
          ...(options.command
            ? {
                skillCommand: {
                  commandName: "daily-brief",
                  skillName,
                  skillSource: "workspace",
                  skillFile,
                  toolName,
                },
              }
            : {}),
        },
      });
      expect(bridge.telemetry.quarantinedTools).toEqual([]);
      expect(bridge.availableTools.map((tool) => tool.name)).toEqual([toolName]);
      for (const tool of bridge.availableTools) {
        expect(getBeforeToolCallDiagnosticOptions(tool)?.emitDiagnostics).toBe(false);
      }
      const call = (callId: string, filePath = skillFile) =>
        bridge.handleToolCall({
          threadId: "skill-usage-thread",
          turnId: "skill-usage-turn",
          callId,
          namespace: "openclaw",
          tool: toolName,
          arguments: { path: filePath },
        });
      return { call, execute };
    }

    function usageRows() {
      return openOpenClawStateDatabase({ env: testState.env })
        .db.prepare(
          "SELECT skill_file, skill_name, skill_source, use_count, last_agent_id FROM skill_usage",
        )
        .all();
    }

    function expectedUsageRow(count: number) {
      return {
        skill_file: skillFile,
        skill_name: skillName,
        skill_source: "workspace",
        use_count: count,
        last_agent_id: "main",
      };
    }

    it.each([false, true])(
      "counts repeated successful reads with process diagnostics=%s",
      async (enabled) => {
        setDiagnosticsEnabledForProcess(enabled);
        const { call, execute } = createBridge();
        expect(await call("read-1")).toMatchObject({
          success: true,
          contentItems: [{ type: "inputText", text: "# Daily brief\n" }],
        });
        await waitForDiagnosticEventsDrained();
        expect(usageRows()).toEqual([expectedUsageRow(1)]);
        expect(await call("read-2")).toMatchObject({ success: true });
        await waitForDiagnosticEventsDrained();
        expect(execute).toHaveBeenCalledTimes(2);
        expect(usageRows()).toEqual([expectedUsageRow(2)]);
        expect(consumeRunSkillUsage(runId)).toEqual([
          { name: skillName, source: "workspace", activation: "read", skillFile },
        ]);
        expect(consumeRunSkillUsage(runId)).toEqual([]);
        expect(publicEvents).toEqual([]);
        expect(sharedEvents.map((event) => event.type)).toEqual(
          enabled ? ["skill.used", "skill.used"] : [],
        );
        expect(trustedEvents.map((event) => event.type)).toEqual(["skill.used", "skill.used"]);
        expect(JSON.stringify([...sharedEvents, ...trustedEvents])).not.toContain(skillFile);
      },
    );

    it.each(["error", "failed", "blocked", "cancelled", "timed_out"])(
      "does not count a structured %s read",
      async (status) => {
        const { call, execute } = createBridge({
          execute: async () => ({
            content: [{ type: "text", text: "Read did not complete" }],
            details: { status },
          }),
        });
        expect(await call("failed-read")).toMatchObject({ success: false });
        await waitForDiagnosticEventsDrained();
        expect(execute).toHaveBeenCalledOnce();
        expect(consumeRunSkillUsage(runId)).toEqual([]);
        expect(usageRows()).toEqual([]);
        expect(trustedEvents).toEqual([]);
      },
    );

    it("does not count a thrown read", async () => {
      const { call } = createBridge({
        execute: async () => {
          throw new Error("Read failed");
        },
      });
      expect(await call("thrown-read")).toMatchObject({ success: false });
      await waitForDiagnosticEventsDrained();
      expect(usageRows()).toEqual([]);
      expect(consumeRunSkillUsage(runId)).toEqual([]);
      expect(trustedEvents).toEqual([]);
    });

    it("does not count a read blocked before execution", async () => {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_tool_call",
            handler: async () => ({ block: true, blockReason: "Blocked by test policy" }),
          },
        ]),
      );
      const { call, execute } = createBridge();
      expect(await call("blocked-read")).toMatchObject({ success: false, executionStarted: false });
      await waitForDiagnosticEventsDrained();
      expect(execute).not.toHaveBeenCalled();
      expect(usageRows()).toEqual([]);
      expect(consumeRunSkillUsage(runId)).toEqual([]);
      expect(trustedEvents).toEqual([]);
    });

    it.each(["skills/unknown/SKILL.md", "README.md"])(
      "does not count reading %s outside the skill snapshot",
      async (filePath) => {
        const otherFile = await testState.writeText(filePath, "Other file\n");
        const { call } = createBridge();
        expect(await call("other-read", otherFile)).toMatchObject({ success: true });
        await waitForDiagnosticEventsDrained();
        expect(usageRows()).toEqual([]);
        expect(consumeRunSkillUsage(runId)).toEqual([]);
        expect(trustedEvents).toEqual([]);
      },
    );

    it("preserves explicit tool-dispatched skill command activation", async () => {
      const { call } = createBridge({ command: true });
      expect(await call("skill-command")).toMatchObject({ success: true });
      await waitForDiagnosticEventsDrained();
      expect(usageRows()).toEqual([expectedUsageRow(1)]);
      expect(consumeRunSkillUsage(runId)).toEqual([
        { name: skillName, source: "workspace", activation: "command", skillFile },
      ]);
      expect(trustedEvents).toMatchObject([
        { type: "skill.used", activation: "command", toolName: "daily_brief" },
      ]);
    });
  });
});
