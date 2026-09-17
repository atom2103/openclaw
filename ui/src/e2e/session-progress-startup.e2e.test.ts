import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const startupCases = [
  { name: "empty", steps: 0, collapsed: false, error: false },
  { name: "error", steps: 0, collapsed: false, error: true },
  { name: "collapsed one item", steps: 1, collapsed: true, error: false },
  { name: "expanded one item", steps: 1, collapsed: false, error: false },
  { name: "collapsed long checklist", steps: 18, collapsed: true, error: false },
  { name: "expanded long checklist", steps: 18, collapsed: false, error: false },
].flatMap(({ name, steps, collapsed, error }) =>
  [50, 800].map((latency) => ({ name, steps, collapsed, error, latency })),
);

suite.define(() => {
  it.each(startupCases)(
    "presents stable history with $name progress after $latency ms while keeping the composer usable",
    async (scenario) => {
      const context = await suite.newBrowserContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "no-preference",
      });
      await context.addInitScript(
        ({ gatewayUrl, settingsKey, collapsed }) => {
          localStorage.setItem(
            settingsKey,
            JSON.stringify({ gatewayUrl, chatCollapseTaskProgress: collapsed }),
          );
        },
        {
          gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
          settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          collapsed: scenario.collapsed,
        },
      );
      const page = await context.newPage();
      const sessionKey = "agent:main:main";
      const card =
        scenario.steps > 0
          ? {
              sessionKey,
              revision: 1,
              updatedAt: 1,
              steps: Array.from({ length: scenario.steps }, (_, index) => ({
                step: `Checklist item ${index + 1}: inspect the conversation and verify its result`,
                status: index === 0 ? "in_progress" : "pending",
              })),
            }
          : null;
      const gateway = await installMockGateway(page, {
        sessionInfo: { key: sessionKey, kind: "direct", updatedAt: 1, hasActiveRun: false },
        historyMessages: Array.from({ length: 40 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: [
            {
              type: "text",
              text:
                index === 39
                  ? "Ready."
                  : `Conversation message ${index + 1}. A synthetic historical turn.`,
            },
          ],
        })),
        deferredMethods: ["chat.startup", "progressCard.get", "chat.send"],
        methodResponses: { "progressCard.get": { card } },
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Queue before history and progress");
        const textarea = await composer.elementHandle();
        expect(textarea).not.toBeNull();
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "startup-note.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Synthetic startup attachment"),
        });
        await page.locator(".chat-attachment-thumb", { hasText: "startup-note.txt" }).waitFor();
        await composer.press("Enter");
        await page
          .locator(".chat-queue")
          .getByText("Queue before history and progress", { exact: true })
          .waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(0);
        const draft = "Keep this draft while progress loads";
        await composer.fill(draft);
        await gateway.resolveDeferred("chat.startup");
        await gateway.waitForRequest("progressCard.get");
        const send = await gateway.waitForRequest("chat.send");
        expect(send.params).toMatchObject({
          sessionKey,
          message: "Queue before history and progress",
          attachments: [expect.objectContaining({ fileName: "startup-note.txt" })],
        });
        // Start before releasing progress: recording after Ready appears would miss
        // the original placeholder-to-card jump and initial virtualizer corrections.
        const geometry = await page.evaluateHandle(() => {
          const frames: Array<{ message: number; composer: number }> = [];
          const composerFrames: number[] = [];
          let frame = 0;
          const sample = () => {
            const input = document.querySelector<HTMLElement>(".agent-chat__input")!;
            const composerTop = input.getBoundingClientRect().top;
            composerFrames.push(composerTop);
            const message = [
              ...document.querySelectorAll<HTMLElement>(".chat-thread .chat-text"),
            ].find((element) => element.textContent?.trim() === "Ready.");
            const thread = message?.closest<HTMLElement>(".chat-thread");
            if (message && thread && message.checkVisibility({ visibilityProperty: true })) {
              const bounds = message.getBoundingClientRect();
              const clip = thread.getBoundingClientRect();
              // Virtual rows can exist thousands of pixels outside the scrollport.
              // Only pixels intersecting its clip can contribute a painted shift.
              if (
                bounds.bottom > Math.max(clip.top, 0) &&
                bounds.top < Math.min(clip.bottom, window.innerHeight, composerTop) &&
                bounds.right > Math.max(clip.left, 0) &&
                bounds.left < Math.min(clip.right, window.innerWidth)
              ) {
                frames.push({ message: bounds.top, composer: composerTop });
              }
            }
            frame = requestAnimationFrame(sample);
          };
          frame = requestAnimationFrame(sample);
          return { frames, composerFrames, cancel: () => cancelAnimationFrame(frame) };
        });
        try {
          // This delay models the actual response latency, rather than allowing a
          // timeout/retry to hide an unexpected early transcript presentation.
          await page.waitForTimeout(scenario.latency);
          expect(
            await page.locator(".chat-thread").getByText("Ready.", { exact: true }).isVisible(),
          ).toBe(false);
          expect(await geometry.evaluate((capture) => capture.frames.length)).toBe(0);
          if (scenario.error) {
            await gateway.rejectDeferred("progressCard.get", {
              message: "Progress temporarily unavailable",
            });
          } else {
            await gateway.resolveDeferred("progressCard.get", { card });
          }
          await page.locator(".chat-thread").getByText("Ready.", { exact: true }).waitFor();
          const progress = page.locator(".session-progress-card--composer");
          expect(await progress.count()).toBe(card ? 1 : 0);
          if (card) {
            expect(await progress.getAttribute("open")).toBe(scenario.collapsed ? null : "");
          }
          await expect
            .poll(() => geometry.evaluate((capture) => capture.frames.length))
            .toBeGreaterThanOrEqual(30);
          const samples = await geometry.evaluate((capture) => ({
            frames: capture.frames,
            composerFrames: capture.composerFrames,
          }));
          for (const surface of ["message", "composer"] as const) {
            const positions = samples.frames.map((sample) => sample[surface]);
            expect(
              Math.max(...positions) - Math.min(...positions),
              `${surface} moved after its first painted frame`,
            ).toBeLessThanOrEqual(0.1);
          }
          expect(
            Math.max(...samples.composerFrames) - Math.min(...samples.composerFrames),
          ).toBeLessThanOrEqual(0.1);
          expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(
            true,
          );
          expect(await composer.inputValue()).toBe(draft);
          expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
        } finally {
          await geometry.evaluate((capture) => capture.cancel());
          await geometry.dispose();
        }

        const progress = page.locator(".session-progress-card--composer");
        if (card) {
          await progress.locator("summary").click();
          await expect
            .poll(() => progress.getAttribute("open"))
            .toBe(scenario.collapsed ? "" : null);
        }
        const mountedCard = card ? await progress.elementHandle() : null;
        const disclosure = card ? await progress.getAttribute("open") : null;
        await composer.fill("Keep this draft while progress refreshes");
        await gateway.deferNext("progressCard.get");
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect
          .poll(async () => (await gateway.getRequests("progressCard.get")).length)
          .toBe(2);
        await gateway.rejectDeferred("progressCard.get", {
          message: "Refresh temporarily unavailable",
        });
        // Allow the rejection and following paint to commit before checking retention.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(true);
        expect(await composer.inputValue()).toBe("Keep this draft while progress refreshes");
        expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
        expect(
          await page.locator(".chat-thread").getByText("Ready.", { exact: true }).isVisible(),
        ).toBe(true);
        if (card) {
          expect(await progress.evaluate((node, original) => node === original, mountedCard)).toBe(
            true,
          );
          expect(await progress.getAttribute("open")).toBe(disclosure);
          expect(await progress.locator(".session-progress-card__step").count()).toBe(
            scenario.steps,
          );
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each(["history", "progress"] as const)(
    "preserves the composer when %s settles first during a history refresh and initial progress read",
    async (first) => {
      const context = await suite.newBrowserContext({});
      const page = await context.newPage();
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, {
        sessionInfo: { key: sessionKey, kind: "direct", updatedAt: 1 },
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
        deferredMethods: ["progressCard.get"],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("progressCard.get");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const draft = "Keep draft and focus through either reply order";
        await composer.fill(draft);
        const textarea = await composer.elementHandle();
        expect(textarea).not.toBeNull();
        // Initial history owns progress admission. A live message can independently
        // refresh that history while the first progress response is still pending.
        await gateway.deferNext("chat.history");
        const before = (await gateway.getRequests("chat.history")).length;
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          session: { key: sessionKey, kind: "direct", updatedAt: 2 },
          messageId: "startup-peer-message",
          messageSeq: 3,
          message: {
            role: "user",
            content: [{ type: "text", text: "A peer joined the conversation." }],
            __openclaw: { id: "startup-peer-message", seq: 3 },
          },
        });
        await gateway.waitForRequest("chat.history", { after: before });
        for (const response of [first, first === "history" ? "progress" : "history"]) {
          if (response === "history") {
            await gateway.resolveDeferred("chat.history");
          } else {
            await gateway.resolveDeferred("progressCard.get", {
              card: { sessionKey, revision: 1, updatedAt: 1, markdown: "Initial task progress" },
            });
            await page.locator(".session-progress-card--composer").waitFor();
          }
          expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(
            true,
          );
          expect(await composer.inputValue()).toBe(draft);
          expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("shows failed initial history and waits for first progress after Retry without replacing the composer", async () => {
    const context = await suite.newBrowserContext({});
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      deferredMethods: ["chat.startup", "progressCard.get"],
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.rejectDeferred("chat.startup", { message: "History temporarily unavailable" });
      const error = page.locator('.chat-history-error[role="alert"]');
      await error.waitFor();
      expect(await error.textContent()).toContain("History temporarily unavailable");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const draft = "Preserve this recovery draft";
      await composer.fill(draft);
      const textarea = await composer.elementHandle();
      expect(textarea).not.toBeNull();
      await gateway.waitForRequest("progressCard.get");
      const startupRequests = (await gateway.getRequests("chat.startup")).length;
      await gateway.deferNext("chat.startup");
      await error.getByRole("button", { name: "Retry" }).click();
      await gateway.waitForRequest("chat.startup", { after: startupRequests });
      await gateway.resolveDeferred("chat.startup");
      await error.waitFor({ state: "detached" });
      await composer.focus();
      // The error was a visible history result, not a completed first progress
      // read. Recovery must still resolve progress before painting the history.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(
        await page.locator(".chat-thread").getByText("Ready.", { exact: true }).isVisible(),
      ).toBe(false);
      expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(true);
      expect(await composer.inputValue()).toBe(draft);
      await gateway.resolveDeferred("progressCard.get", {
        card: {
          sessionKey: "agent:main:main",
          revision: 1,
          updatedAt: 1,
          markdown: "Recovered task progress",
        },
      });
      await page.locator(".chat-thread").getByText("Ready.", { exact: true }).waitFor();
      await page.locator(".session-progress-card--composer").waitFor();
      expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(true);
      expect(await composer.inputValue()).toBe(draft);
      expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
