import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar agent menu scope", () => {
  it.each([0, 1])(
    "keeps the mode toggle and agent actions with %i configured agents",
    async (count) => {
      const gateway = createGateway({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(
        gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: count === 0 ? [] : [{ id: "main", identity: { name: "Molty", emoji: "🦞" } }],
        },
      );
      sidebar.connected = true;
      await sidebar.updateComplete;

      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector(".sidebar-agent-menu");
      expect(menu?.querySelector(".sidebar-customize-menu__title")).toBeNull();
      expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(1);
      expect(menu?.querySelector(".sidebar-agent-menu__filter")).toBeNull();
      expect(menu?.querySelector(".sidebar-agent-menu__agent-switch")).toBeNull();
      expect(
        [...(menu?.children ?? [])]
          .filter((element) => element.localName === "wa-dropdown-item")
          .map((element) => element.getAttribute("value")),
      ).toEqual(["command:new-agent", "command:capabilities", "command:agent-settings"]);
      expect(menu?.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(false);
    },
  );

  it.each(["chip", "roster"] as const)(
    "opens the active agent's settings in %s mode",
    async (mode) => {
      const gateway = createGateway({} as GatewayBrowserClient);
      const { sidebar, context } = await mountSidebar(
        gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        TWO_AGENTS,
      );
      const onNavigate = vi.fn();
      sidebar.connected = true;
      sidebar.onNavigate = onNavigate;
      sidebar.activeRouteId = "skills";
      context.agentSelection.set("research");
      context.agentSelection.setScope(null);
      sidebar.sidebarAgentsMode = mode;
      await sidebar.updateComplete;

      sidebar
        .querySelector<HTMLButtonElement>(
          ".sidebar-agent-card__main, .sidebar-workspace-header__main",
        )
        ?.click();
      await sidebar.updateComplete;
      const actionRow = sidebar.querySelector<HTMLElement>(
        '.sidebar-agent-menu [value="command:agent-settings"]',
      );
      expect(actionRow).not.toBeNull();
      actionRow?.click();
      await sidebar.updateComplete;
      expect(onNavigate).toHaveBeenCalledWith("agents", { pathname: "/settings/agents/research" });
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    },
  );

  it.each(["main", "research"])(
    "chooses %s from the workspace menu and leaves roster mode",
    async (agentId) => {
      const { sidebar, context } = await mountSidebar(
        createGatewayHarness({} as GatewayBrowserClient).gateway,
        createSessions("main", ["agent:main:main", "agent:research:main"]),
        "panel",
        TWO_AGENTS,
      );
      sidebar.activeRouteId = "skills";
      sidebar.connected = true;
      sidebar.sidebarAgentsMode = "roster";
      context.agentSelection.setScope(null);
      await sidebar.updateComplete;
      sidebar.querySelector<HTMLButtonElement>(".sidebar-workspace-header__main")?.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector(".sidebar-agent-menu")!;
      expect(menu.querySelector("[aria-checked], .session-menu__check")).toBeNull();
      expect(
        menu.querySelector(".sidebar-agent-menu__agent-switch--active")?.getAttribute("value"),
      ).toBe("agent:main");
      const rosterSwitch = menu.querySelector<HTMLInputElement>('input[role="switch"]');
      expect(rosterSwitch?.checked).toBe(true);
      expect(rosterSwitch?.closest("label")?.textContent?.trim()).toBe(
        "Show all agents in sidebar",
      );
      expect(menu.querySelector('[value="command:help"], [value="command:all-agents"]')).toBeNull();
      menu.querySelector<HTMLElement>(`[value="agent:${agentId}"]`)?.click();
      await sidebar.updateComplete;
      expect(sidebar.sidebarAgentsMode).toBe("chip");
      expect(sidebar.activeRouteId).toBe("skills");
      expect(context.agentSelection.state).toEqual({ selectedId: agentId, scopeId: agentId });
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      expect(sidebar.querySelector(".sidebar-agent-card__main")).not.toBeNull();
    },
  );

  it("keeps the active agent ring when page scope is all agents and switches roster on and off", async () => {
    const { sidebar, context } = await mountSidebar(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    sidebar.activeRouteId = "skills";
    context.agentSelection.set("research");
    context.agentSelection.setScope(null);
    await sidebar.updateComplete;
    for (const mode of ["chip", "roster"] as const) {
      sidebar
        .querySelector<HTMLButtonElement>(
          ".sidebar-agent-card__main, .sidebar-workspace-header__main",
        )
        ?.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector(".sidebar-agent-menu")!;
      expect(
        menu.querySelector(".sidebar-agent-menu__agent-switch--active")?.getAttribute("value"),
      ).toBe("agent:research");
      expect(
        menu.querySelector('[aria-checked], .session-menu__check, [value="command:all-agents"]'),
      ).toBeNull();
      expect(
        [...menu.querySelectorAll('wa-dropdown-item[value^="command:"]')].map((item) =>
          item.getAttribute("value"),
        ),
      ).toEqual(["command:new-agent", "command:capabilities", "command:agent-settings"]);
      const rosterSwitch = menu.querySelector<HTMLInputElement>('input[role="switch"]')!;
      expect(rosterSwitch.checked).toBe(mode === "roster");
      rosterSwitch.click();
      await vi.waitFor(() =>
        expect(sidebar.sidebarAgentsMode).toBe(mode === "chip" ? "roster" : "chip"),
      );
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      expect(context.agentSelection.state.selectedId).toBe("research");
    }
  });
});
