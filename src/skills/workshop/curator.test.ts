import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasInternalDiagnosticEventInterest } from "../../infra/diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent,
  emitTrustedSkillUsedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { getSkillCuratorStatus, registerSkillUsageTracking } from "./curator.js";
import {
  applySkillProposal as applySkillProposalImpl,
  proposeCreateSkill as proposeCreateSkillImpl,
} from "./service.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

let testState: OpenClawTestState;
const workshopConfig: OpenClawConfig = {};
type OptionalWorkshopConfig<T> = Omit<T, "config"> & { config?: OpenClawConfig };
const applySkillProposal = (
  input: OptionalWorkshopConfig<Parameters<typeof applySkillProposalImpl>[0]>,
) => applySkillProposalImpl({ config: workshopConfig, ...input });
const proposeCreateSkill = (
  input: OptionalWorkshopConfig<Parameters<typeof proposeCreateSkillImpl>[0]>,
) => proposeCreateSkillImpl({ config: workshopConfig, ...input });

async function writeInventorySkill(
  config: OpenClawConfig,
  agentId: string,
  directory: string,
  name = directory,
) {
  const skillFile = path.join(
    resolveWorkshopSkillsDir(config, agentId, testState.env),
    directory,
    "SKILL.md",
  );
  await fs.mkdir(path.dirname(skillFile), { recursive: true });
  await fs.writeFile(
    skillFile,
    `---\nname: ${name}\ndescription: Inventory fixture\n---\nInstructions\n`,
  );
  return skillFile;
}

beforeEach(async () => {
  resetDiagnosticEventsForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
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

  it("reports live usage for existing applied workshop skills and excludes missing files", async () => {
    const proposal = await proposeCreateSkill({
      workspaceDir: testState.workspaceDir,
      env: testState.env,
      agentId: "main",
      name: "Daily Brief",
      description: "Prepare a daily briefing",
      content: "# Daily Brief\nPrepare the daily briefing.\n",
    });
    const applied = await applySkillProposal({
      workspaceDir: testState.workspaceDir,
      env: testState.env,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });
    const skillFile = proposal.record.target.skillFile;
    const database = openOpenClawStateDatabase({ env: testState.env });
    database.db
      .prepare(
        `INSERT INTO skill_usage (
          skill_file, skill_key, skill_name, skill_source,
          first_used_at_ms, last_used_at_ms, use_count, last_agent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(skillFile, "daily-brief", "Daily Brief", "workspace", 1_000, 2_000, 3, "main");

    expect(getSkillCuratorStatus({ config: workshopConfig, env: testState.env })).toMatchObject({
      counts: { active: 1, stale: 0, archived: 0 },
      overlaps: [],
      skills: [
        {
          skillFile,
          skillKey: "daily-brief",
          skillName: "daily-brief",
          state: "active",
          pinned: false,
          createdAtMs: Date.parse(applied.record.appliedAt!),
          stateChangedAtMs: Date.parse(applied.record.appliedAt!),
          lastUsedAtMs: 2_000,
          useCount: 3,
          archivedReason: null,
        },
      ],
    });

    expect(
      getSkillCuratorStatus({
        config: { agents: { entries: { other: { agentDir: testState.path("other-agent") } } } },
        env: testState.env,
      }).skills,
    ).toEqual([]);
    await fs.unlink(skillFile);
    expect(getSkillCuratorStatus({ config: workshopConfig, env: testState.env })).toMatchObject({
      counts: { active: 0, stale: 0, archived: 0 },
      skills: [],
      overlaps: [],
    });
    expect(
      database.db
        .prepare("SELECT count(*) AS count FROM skill_workshop_proposals WHERE status = 'applied'")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("uses current multi-agent roots and file identity despite disabled skills and duplicate roots", async () => {
    const alphaDir = testState.path("alpha-agent");
    const config: OpenClawConfig = {
      agents: {
        entries: {
          alpha: { agentDir: alphaDir, skills: ["other"] },
          beta: { agentDir: testState.path("beta-agent") },
          mirror: { agentDir: alphaDir },
          missing: { agentDir: testState.path("absent-agent") },
        },
      },
      skills: { entries: { shared: { enabled: false } } },
    };
    const alphaFile = await writeInventorySkill(config, "alpha", "first", "shared");
    const betaFile = await writeInventorySkill(config, "beta", "second", "shared");
    const unusedFile = await writeInventorySkill(config, "beta", "unused");
    const database = openOpenClawStateDatabase({ env: testState.env });
    const insert = database.db.prepare(
      `INSERT INTO skill_usage (skill_file, skill_key, skill_name, skill_source, first_used_at_ms, last_used_at_ms, use_count, last_agent_id) VALUES (?, 'shared', 'Old Name', 'workspace', 10, 20, ?, 'alpha')`,
    );
    insert.run(alphaFile, 1);
    insert.run(betaFile, 2);
    const read = () => getSkillCuratorStatus({ config, env: testState.env });
    expect(read()).toMatchObject({
      inventory: "live-workshop",
      counts: { active: 3, stale: 0, archived: 0 },
      skills: [
        {
          skillFile: alphaFile,
          skillName: "shared",
          useCount: 1,
          lastUsedAtMs: 20,
          createdAtMs: null,
          stateChangedAtMs: null,
        },
        {
          skillFile: betaFile,
          skillName: "shared",
          useCount: 2,
          lastUsedAtMs: 20,
          createdAtMs: null,
          stateChangedAtMs: null,
        },
        {
          skillFile: unusedFile,
          useCount: 0,
          lastUsedAtMs: null,
          createdAtMs: null,
          stateChangedAtMs: null,
        },
      ],
    });
    await writeInventorySkill(config, "alpha", "first", "renamed");
    expect(read().skills[0]).toMatchObject({
      skillFile: alphaFile,
      skillName: "renamed",
      skillKey: "renamed",
      useCount: 1,
    });
    const movedFile = path.join(path.dirname(path.dirname(betaFile)), "moved", "SKILL.md");
    await fs.rename(path.dirname(betaFile), path.dirname(movedFile));
    expect(read().skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillFile: movedFile,
          skillName: "shared",
          useCount: 0,
          lastUsedAtMs: null,
        }),
      ]),
    );
    expect(read().skills.map((skill) => skill.skillFile)).not.toContain(betaFile);
    config.agents = { entries: { alpha: { agentDir: testState.path("replacement-root") } } };
    expect(read()).toMatchObject({ counts: { active: 0, stale: 0, archived: 0 }, skills: [] });
  });
});
