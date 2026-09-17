import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { SessionGoal } from "../../api/types.ts";
import { renderComposerMenu } from "../../components/composer-menu.ts";
import { createComposerProps } from "./chat-composer.test-support.ts";
import { renderAttachmentPreview } from "./components/chat-attachments.ts";
import { renderChatGoal } from "./components/chat-composer-goal.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import baseStyles from "../../styles/base.css?inline";
import goalStyles from "../../styles/chat/composer-progress.css?inline";
import composerSurfaceStyles from "../../styles/chat/composer-surface.css?inline";
import composerStyles from "../../styles/chat/composer.css?inline";

const attachments = Array.from({ length: 7 }, (_, index) => ({
  id: `overflow-${index}`,
  fileName: `fixture-${index}.txt`,
  mimeType: "text/plain",
}));
const afterLayout = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

describe("composer overflow presentation", () => {
  let container: HTMLDivElement;
  let styles: HTMLStyleElement;

  beforeEach(async () => {
    await page.viewport(1200, 800);
    styles = document.createElement("style");
    styles.textContent = [baseStyles, composerStyles, composerSurfaceStyles, goalStyles].join("\n");
    document.head.append(styles);
    container = document.createElement("div");
    container.className = "agent-chat__input";
    container.style.width = "760px";
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    styles.remove();
    resetChatComposerState();
  });

  function drawAttachments(count: number) {
    return render(renderAttachmentPreview({ attachments: attachments.slice(0, count) }), container);
  }

  function rail() {
    return container.querySelector<HTMLElement>(".chat-attachments-preview")!;
  }

  it.each([390, 1440])(
    "keeps long reply context and its dismiss control inside the composer at %ipx",
    async (width) => {
      await page.viewport(width, 900);
      container.className = "";
      container.style.width = `${Math.min(width - 32, 760)}px`;
      render(
        renderChatComposer(
          createComposerProps({
            goalDraftMode: { action: "start" },
            replyTarget: {
              messageId: "context-strip-reply",
              senderLabel: "A very long sender name ".repeat(12),
              text: "A long message excerpt that must leave room for cancellation. ".repeat(8),
            },
          }),
        ),
        container,
      );
      await afterLayout();

      const composer = container.querySelector<HTMLElement>(".agent-chat__input")!;
      const reply = container.querySelector<HTMLElement>(".chat-reply-preview")!;
      const goal = container.querySelector<HTMLElement>(".agent-chat__goal-mode")!;
      const text = reply.querySelector<HTMLElement>(".chat-reply-preview__text")!;
      const dismiss = reply.querySelector<HTMLButtonElement>("button")!;
      const composerBox = composer.getBoundingClientRect();
      const replyBox = reply.getBoundingClientRect();
      const dismissBox = dismiss.getBoundingClientRect();

      expect(dismissBox.width).toBeGreaterThan(0);
      expect(dismissBox.left).toBeGreaterThanOrEqual(replyBox.left);
      expect(dismissBox.right).toBeLessThanOrEqual(replyBox.right);
      expect(replyBox.left).toBeGreaterThanOrEqual(composerBox.left);
      expect(replyBox.right).toBeLessThanOrEqual(composerBox.right);
      expect(composer.scrollWidth).toBeLessThanOrEqual(composer.clientWidth + 1);
      expect(text.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
      expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight + 1);

      const surface = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          border: style.border,
          borderRadius: style.borderRadius,
          padding: style.padding,
          margin: style.margin,
        };
      };
      expect(surface(reply)).toEqual(surface(goal));
      expect(replyBox.height).toBeCloseTo(goal.getBoundingClientRect().height, 0);
    },
  );

  async function expectEdges(
    element: HTMLElement,
    scrollable: boolean,
    atStart = true,
    atEnd = !scrollable,
  ) {
    await expect
      .poll(() => ({
        scrollable: element.dataset.scrollable,
        atStart: element.dataset.atStart,
        atEnd: element.dataset.atEnd,
      }))
      .toMatchObject({
        scrollable: String(scrollable),
        atStart: String(atStart),
        atEnd: String(atEnd),
      });
    expect(getComputedStyle(element).maskImage === "none").toBe(!scrollable);
  }

  it("updates retained attachment edges when files are appended, scrolled, and removed", async () => {
    drawAttachments(1);
    const element = rail();
    await afterLayout();
    await expectEdges(element, false);

    drawAttachments(7);
    expect(rail()).toBe(element);
    expect(element.scrollWidth).toBeGreaterThan(element.clientWidth);
    await expectEdges(element, true);
    element.scrollLeft = element.scrollWidth;
    await expectEdges(element, true, false, true);

    drawAttachments(1);
    await expectEdges(element, false);
  });

  it("updates retained attachment edges when the composer narrows and widens", async () => {
    drawAttachments(3);
    const element = rail();
    await afterLayout();
    await expectEdges(element, false);

    container.style.width = "400px";
    expect(rail()).toBe(element);
    expect(element.scrollWidth).toBeGreaterThan(element.clientWidth);
    await expectEdges(element, true);

    container.style.width = "760px";
    await expectEdges(element, false);
  });

  it("resumes overflow observation when a retained composer reconnects", async () => {
    const part = drawAttachments(3);
    const element = rail();
    await afterLayout();
    await expectEdges(element, false);

    part.setConnected(false);
    container.style.width = "400px";
    await afterLayout();
    await expectEdges(element, false);

    part.setConnected(true);
    expect(rail()).toBe(element);
    await expectEdges(element, true);
    container.style.width = "760px";
    await expectEdges(element, false);
  });

  it("preserves expanded mobile goal edges as its objective changes and scrolls", async () => {
    await page.viewport(480, 800);
    container.style.width = "400px";
    const state = getChatComposerState("overflow-goal");
    state.goalExpandedId = "overflow-goal";
    const goal: SessionGoal = {
      schemaVersion: 1,
      id: "overflow-goal",
      objective: "Fixture objective\n".repeat(30),
      status: "complete",
      createdAt: 1000,
      updatedAt: 2000,
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    };
    const drawGoal = () =>
      render(
        renderChatGoal(state, goal, {
          canAct: false,
          requestUpdate: () => {},
        }),
        container,
      );
    drawGoal();
    const element = container.querySelector<HTMLElement>(".agent-chat__goal-detail-objective")!;
    expect(element.scrollHeight).toBeGreaterThan(element.clientHeight);
    await expectEdges(element, true);
    element.scrollTop = element.scrollHeight;
    await expectEdges(element, true, false, true);

    goal.objective = "Short objective";
    drawGoal();
    expect(container.querySelector(".agent-chat__goal-detail-objective")).toBe(element);
    await expectEdges(element, false);
  });

  it("updates menu edges when retained results grow, scroll, and shrink", async () => {
    const drawMenu = (count: number) =>
      render(
        renderComposerMenu({
          id: "overflow-menu",
          label: "Fixture results",
          content: Array.from(
            { length: count },
            (_, index) => html`<div style="height: 40px">Result ${index}</div>`,
          ),
        }),
        container,
      );
    drawMenu(1);
    const element = container.querySelector<HTMLElement>(".slash-menu__scroll")!;
    await afterLayout();
    await expectEdges(element, false);

    drawMenu(20);
    expect(container.querySelector(".slash-menu__scroll")).toBe(element);
    expect(element.scrollHeight).toBeGreaterThan(element.clientHeight);
    await expectEdges(element, true);
    element.scrollTop = element.scrollHeight;
    await expectEdges(element, true, false, true);

    drawMenu(1);
    await expectEdges(element, false);
  });
});
