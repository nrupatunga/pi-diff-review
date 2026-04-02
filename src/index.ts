import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, fuzzyFilter } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { getDiffReviewFiles, loadFileContents, listBranches, type BranchCompareOptions } from "./git.js";
import { getPRFiles, getPRComments } from "./github.js";
import { composeReviewPrompt } from "./prompt.js";
import type {
  DiffReviewComment,
  DiffReviewFileContents,
  ReviewCancelPayload,
  ReviewHostMessage,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";
import { buildReviewHtml } from "./ui.js";

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === "request-file";
}

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

type WaitingEditorResult = "escape" | "window-settled";

function withSanitizedGlimpseEnv<T>(fn: () => T): T {
  const previousLd = process.env.LD_LIBRARY_PATH;
  const previousDbusSystem = process.env.DBUS_SYSTEM_BUS_ADDRESS;

  try {
    if (process.platform === "linux") {
      const ld = process.env.LD_LIBRARY_PATH ?? "";
      process.env.LD_LIBRARY_PATH = ld
        .split(":")
        .filter((p) => p.length > 0 && !/\/anaconda3\/lib\/?$/.test(p))
        .join(":");

      if ((process.env.DBUS_SYSTEM_BUS_ADDRESS ?? "").includes("anaconda3")) {
        delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
      }
    }

    return fn();
  } finally {
    if (previousLd == null) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = previousLd;

    if (previousDbusSystem == null) delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
    else process.env.DBUS_SYSTEM_BUS_ADDRESS = previousDbusSystem;
  }
}

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;
  let lastBranchCompare: BranchCompareOptions | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            "The native diff review window is open.",
            "Press Escape to cancel and close the review window.",
          ];
          return [
            borderTop,
            ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  function pickBranch(
    ctx: ExtensionCommandContext,
    branches: string[],
    title: string,
  ): Promise<string | undefined> {
    const MAX_VISIBLE = 10;

    return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
      let query = "";
      let selectedIndex = 0;

      function getFiltered(): string[] {
        return fuzzyFilter(branches, query, (b) => b);
      }

      /** Pad a (possibly ANSI-styled) string to exactly `targetWidth` visible columns. */
      function padVisible(text: string, targetWidth: number): string {
        const vw = visibleWidth(text);
        return vw < targetWidth ? text + " ".repeat(targetWidth - vw) : text;
      }

      function borderedLine(content: string): string {
        return `${theme.fg("border", "│")}${content}${theme.fg("border", "│")}`;
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(30, width - 2);
          const borderH = "─".repeat(innerWidth);
          const lines: string[] = [];

          // Title bar
          const titleText = ` ${title} `;
          const titleVW = visibleWidth(titleText);
          const titlePad = Math.max(0, innerWidth - titleVW);
          const leftPad = Math.floor(titlePad / 2);
          const rightPad = titlePad - leftPad;
          lines.push(
            theme.fg("border", `╭${"─".repeat(leftPad)}`) +
            theme.fg("accent", theme.bold(titleText)) +
            theme.fg("border", `${"─".repeat(rightPad)}╮`),
          );

          // Search input
          const searchPrefix = " \uD83D\uDD0D ";
          const cursor = theme.fg("accent", "▏");
          const searchContent = `${searchPrefix}${query}${cursor}`;
          lines.push(borderedLine(padVisible(searchContent, innerWidth)));
          lines.push(theme.fg("border", `├${borderH}┤`));

          // Filtered branch list
          const filtered = getFiltered();

          if (filtered.length === 0) {
            const noMatch = "  No matching branches";
            lines.push(borderedLine(padVisible(theme.fg("muted", noMatch), innerWidth)));
          } else {
            // Scrolling window
            const startIndex = Math.max(
              0,
              Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), filtered.length - MAX_VISIBLE),
            );
            const endIndex = Math.min(startIndex + MAX_VISIBLE, filtered.length);

            for (let i = startIndex; i < endIndex; i++) {
              const branch = filtered[i];
              const isSelected = i === selectedIndex;
              const prefix = isSelected ? " → " : "   ";
              const text = truncateToWidth(`${prefix}${branch}`, innerWidth, "...");
              const styled = isSelected ? theme.fg("accent", theme.bold(text)) : text;
              lines.push(borderedLine(padVisible(styled, innerWidth)));
            }

            // Scroll indicator
            if (filtered.length > MAX_VISIBLE) {
              const info = `  (${selectedIndex + 1}/${filtered.length})`;
              lines.push(borderedLine(padVisible(theme.fg("muted", info), innerWidth)));
            }
          }

          // Bottom border with hints
          const hints = " ↑↓ navigate · Enter select · Esc cancel ";
          const hintsVW = visibleWidth(hints);
          const hintsPad = Math.max(0, innerWidth - hintsVW);
          const hLeftPad = Math.floor(hintsPad / 2);
          const hRightPad = hintsPad - hLeftPad;
          lines.push(
            theme.fg("border", `╰${"─".repeat(hLeftPad)}`) +
            theme.fg("muted", hints) +
            theme.fg("border", `${"─".repeat(hRightPad)}╯`),
          );

          return lines;
        },

        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            done(undefined);
            return;
          }

          const filtered = getFiltered();

          if (matchesKey(data, Key.enter)) {
            const selected = filtered[selectedIndex];
            done(selected ?? undefined);
            return;
          }

          if (matchesKey(data, Key.up)) {
            selectedIndex = selectedIndex === 0 ? Math.max(0, filtered.length - 1) : selectedIndex - 1;
            tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.down)) {
            selectedIndex = selectedIndex >= filtered.length - 1 ? 0 : selectedIndex + 1;
            tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.backspace)) {
            if (query.length > 0) {
              query = query.slice(0, -1);
              selectedIndex = 0;
              tui.requestRender();
            }
            return;
          }

          // Printable characters
          if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
            query += data;
            selectedIndex = 0;
            tui.requestRender();
          }
        },

        invalidate(): void {},
      };
    });
  }

  async function reviewDiff(
    ctx: ExtensionCommandContext,
    targetDir?: string,
    branchCompare?: BranchCompareOptions,
    initialComments?: DiffReviewComment[],
  ): Promise<void> {
    if (activeWindow != null) {
      ctx.ui.notify("A diff review window is already open.", "warning");
      return;
    }

    const expanded = targetDir?.startsWith("~") ? targetDir.replace(/^~/, process.env.HOME ?? "") : targetDir;
    const cwd = expanded ? resolve(ctx.cwd, expanded) : ctx.cwd;
    const { repoRoot, files } = await getDiffReviewFiles(pi, cwd, branchCompare);
    if (files.length === 0) {
      ctx.ui.notify("No diff between the specified refs.", "info");
      return;
    }

    if (branchCompare != null) {
      lastBranchCompare = {
        branch1: branchCompare.branch1,
        branch2: branchCompare.branch2,
      };
    }

    const titleSuffix = branchCompare
      ? ` — ${branchCompare.branch1}..${branchCompare.branch2}`
      : "";
    const html = buildReviewHtml({
      repoRoot,
      files,
      branchCompare: branchCompare
        ? { branch1: branchCompare.branch1, branch2: branchCompare.branch2 }
        : undefined,
      initialComments,
    });
    const window = withSanitizedGlimpseEnv(() =>
      open(html, {
        width: 1440,
        height: 900,
        title: `pi diff review${titleSuffix}`,
      }),
    );
    activeWindow = window;

    const waitingUI = showWaitingUI(ctx);
    const fileMap = new Map(files.map((file) => [file.id, file]));
    const fileOrder = files.map((file) => file.id);
    const contentCache = new Map<string, Promise<DiffReviewFileContents>>();

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return;
      const payload = escapeForInlineScript(JSON.stringify(message));
      window.send(`window.__reviewReceive(${payload});`);
    };

    const loadContents = (fileId: string): Promise<DiffReviewFileContents> => {
      const cached = contentCache.get(fileId);
      if (cached != null) return cached;
      const file = fileMap.get(fileId);
      if (file == null) return Promise.resolve({ oldContent: "", newContent: "" });
      const pending = loadFileContents(pi, repoRoot, file, branchCompare);
      contentCache.set(fileId, pending);
      return pending;
    };

    const prefetchAround = (fileId: string, count = 2): void => {
      const index = fileOrder.indexOf(fileId);
      if (index < 0) return;
      for (let offset = 1; offset <= count; offset++) {
        const next = fileOrder[index + offset];
        const prev = fileOrder[index - offset];
        if (next) {
          void loadContents(next).catch(() => {});
        }
        if (prev) {
          void loadContents(prev).catch(() => {});
        }
      }
    };

    // Warm the first files in background to reduce visible loading on initial navigation.
    for (const id of fileOrder.slice(0, 2)) {
      void loadContents(id).catch(() => {});
    }

    ctx.ui.notify("Opened native diff review window.", "info");

    try {
      const terminalMessagePromise = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
          try {
            const contents = await loadContents(message.fileId);
            sendWindowMessage({
              type: "file-data",
              requestId: message.requestId,
              fileId: message.fileId,
              oldContent: contents.oldContent,
              newContent: contents.newContent,
            });
            prefetchAround(message.fileId, 2);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              message: messageText,
            });
          }
        };

        const onMessage = (data: unknown): void => {
          const message = data as ReviewWindowMessage;
          if (isRequestFilePayload(message)) {
            void handleRequestFile(message);
            return;
          }
          if (isSubmitPayload(message) || isCancelPayload(message)) {
            settle(message);
          }
        };

        const onClosed = (): void => {
          settle(null);
        };

        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify("Diff review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Diff review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(files, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted diff review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Diff review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description:
      "Open a native diff review window. Usage: /diff-review [path] | /diff-review <branch1> <branch2>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter((p) => p.length > 0);

      if (parts.length === 2) {
        // Two args: branch-to-branch comparison
        const [branch1, branch2] = parts;
        await reviewDiff(ctx, undefined, { branch1, branch2 });
      } else if (parts.length === 1) {
        // One arg: treat as target directory (original behavior)
        await reviewDiff(ctx, parts[0]);
      } else {
        // No args: working tree vs HEAD (original behavior)
        await reviewDiff(ctx);
      }
    },
  });

  pi.registerCommand("diff-review-branches", {
    description: "Pick two branches interactively and open a diff review window.",
    handler: async (_args, ctx) => {
      const { branches } = await listBranches(pi, ctx.cwd);
      if (branches.length === 0) {
        ctx.ui.notify("No branches found in this repository.", "warning");
        return;
      }

      const branch1 = await pickBranch(ctx, branches, "Select base branch (old)");
      if (branch1 == null) {
        ctx.ui.notify("Branch selection cancelled.", "info");
        return;
      }

      const branch2 = await pickBranch(ctx, branches, "Select compare branch (new)");
      if (branch2 == null) {
        ctx.ui.notify("Branch selection cancelled.", "info");
        return;
      }

      if (branch1 === branch2) {
        ctx.ui.notify("Both branches are the same — nothing to diff.", "warning");
        return;
      }

      await reviewDiff(ctx, undefined, { branch1, branch2 });
    },
  });

  pi.registerCommand("diff-review-last", {
    description: "Re-run the last branch-to-branch diff review.",
    handler: async (_args, ctx) => {
      if (lastBranchCompare == null) {
        ctx.ui.notify(
          "No previous branch comparison in this session. Run /diff-review <branch1> <branch2> or /diff-review-branches first.",
          "warning",
        );
        return;
      }
      await reviewDiff(ctx, undefined, {
        branch1: lastBranchCompare.branch1,
        branch2: lastBranchCompare.branch2,
      });
    },
  });

  pi.registerCommand("diff-review-pr", {
    description: "Review a GitHub PR with pre-loaded review comments. Usage: /diff-review-pr <number>",
    handler: async (args, ctx) => {
      const prNumber = args.trim();
      if (!prNumber || !/^\d+$/.test(prNumber)) {
        ctx.ui.notify("Usage: /diff-review-pr <PR number>", "warning");
        return;
      }

      ctx.ui.notify(`Fetching PR #${prNumber} diff and comments...`, "info");

      try {
        const { repoRoot, files, branchCompare, prTitle, prUrl } = await getPRFiles(pi, ctx.cwd, prNumber);
        if (files.length === 0) {
          ctx.ui.notify(`PR #${prNumber} has no changed files.`, "info");
          return;
        }

        const prComments = await getPRComments(pi, ctx.cwd, prNumber, files, prUrl);
        ctx.ui.notify(`Loaded ${prComments.length} comment(s) from PR #${prNumber}.`, "info");

        await reviewDiff(ctx, undefined, branchCompare, prComments);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to load PR #${prNumber}: ${message}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
