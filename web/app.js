const reviewData = JSON.parse(document.getElementById("diff-review-data").textContent || "{}");

const state = {
  activeFileId: reviewData.files[0]?.id ?? null,
  comments: [],
  overallComment: "",
  hideUnchanged: false,
  wrapLines: true,
  collapsedDirs: {},
  reviewedFiles: {},
  scrollPositions: {},
  vim: {
    side: "modified",
    visualAnchor: null,
    pendingKey: null,
  },
};

const repoRootEl = document.getElementById("repo-root");
const fileTreeEl = document.getElementById("file-tree");
const summaryEl = document.getElementById("summary");
const currentFileLabelEl = document.getElementById("current-file-label");
const mainPaneEl = document.getElementById("main-pane");
const fileCommentsContainer = document.getElementById("file-comments-container");
const editorContainerEl = document.getElementById("editor-container");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const overallCommentButton = document.getElementById("overall-comment-button");
const fileCommentButton = document.getElementById("file-comment-button");
const toggleReviewedButton = document.getElementById("toggle-reviewed-button");
const toggleUnchangedButton = document.getElementById("toggle-unchanged-button");
const toggleWrapButton = document.getElementById("toggle-wrap-button");

repoRootEl.textContent = reviewData.repoRoot || "";

let monacoApi = null;
let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let originalDecorations = [];
let modifiedDecorations = [];
let activeViewZones = [];
let editorResizeObserver = null;

function saveCurrentScrollPosition() {
  if (!diffEditor || !state.activeFileId) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  state.scrollPositions[state.activeFileId] = {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreFileScrollPosition() {
  if (!diffEditor || !state.activeFileId) return;
  const scrollState = state.scrollPositions[state.activeFileId];
  if (!scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function captureScrollState() {
  if (!diffEditor) return null;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  return {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreScrollState(scrollState) {
  if (!diffEditor || !scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function inferLanguage(path) {
  if (!path) return "plaintext";
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".sh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt")) return "kotlin";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "c";
  if (lower.endsWith(".cc") || lower.endsWith(".cpp") || lower.endsWith(".cxx") || lower.endsWith(".hpp") || lower.endsWith(".hh") || lower.endsWith(".hxx")) return "cpp";
  return "plaintext";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function statusLabel(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusBadgeClass(status) {
  switch (status) {
    case "added": return "text-[#3fb950]";
    case "deleted": return "text-[#f85149]";
    case "renamed": return "text-[#d29922]";
    default: return "text-[#58a6ff]";
  }
}

function isFileReviewed(fileId) {
  return state.reviewedFiles[fileId] === true;
}

function activeFile() {
  return reviewData.files.find((file) => file.id === state.activeFileId) ?? null;
}

function buildTree(files) {
  const root = { name: "", path: "", kind: "dir", children: new Map(), file: null };
  for (const file of files) {
    const path = file.newPath || file.oldPath || file.displayPath;
    const parts = path.split("/");
    let node = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: currentPath,
          kind: isLeaf ? "file" : "dir",
          children: new Map(),
          file: isLeaf ? file : null,
        });
      }
      node = node.children.get(part);
      if (isLeaf) node.file = file;
    }
  }
  return root;
}

function renderTreeNode(node, depth) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const indentPx = 12;

  for (const child of children) {
    if (child.kind === "dir") {
      const collapsed = state.collapsedDirs[child.path] === true;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-[#c9d1d9] hover:bg-[#21262d]";
      row.style.paddingLeft = `${depth * indentPx + 8}px`;
      row.innerHTML = `
        <svg class="h-4 w-4 shrink-0 text-[#8b949e] transition-transform ${collapsed ? "-rotate-90" : ""}" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.78 6.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 7.28a.749.749 0 0 1 1.06-1.06L8 9.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
        </svg>
        <span class="truncate">${escapeHtml(child.name)}</span>
      `;
      row.addEventListener("click", () => {
        state.collapsedDirs[child.path] = !collapsed;
        renderTree();
      });
      fileTreeEl.appendChild(row);
      if (!collapsed) {
        renderTreeNode(child, depth + 1);
      }
      continue;
    }

    const file = child.file;
    const count = state.comments.filter((comment) => comment.fileId === file.id).length;
    const reviewed = isFileReviewed(file.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "group flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[11px]",
      file.id === state.activeFileId ? "bg-[#373e47] text-white" : reviewed ? "text-[#c9d1d9] hover:bg-[#21262d]" : "text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]",
    ].join(" ");
    button.style.paddingLeft = `${(depth * indentPx) + 26}px`;
    button.innerHTML = `
      <span class="flex min-w-0 items-center gap-1.5 truncate ${file.id === state.activeFileId ? "font-medium" : ""}">
        <span class="shrink-0 text-[10px] ${reviewed ? "text-[#3fb950]" : "text-transparent"}">●</span>
        <span class="truncate">${escapeHtml(child.name)}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        ${count > 0 ? `<span class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#1f2937] px-1 text-[10px] font-medium text-[#c9d1d9]">${count}</span>` : ""}
        <span class="font-medium ${statusBadgeClass(file.status)}">${escapeHtml(statusLabel(file.status).charAt(0))}</span>
      </span>
    `;
    button.addEventListener("click", () => {
      saveCurrentScrollPosition();
      state.activeFileId = file.id;
      renderAll({ restoreFileScroll: true });
    });
    fileTreeEl.appendChild(button);
  }
}

function updateToggleButtons() {
  const file = activeFile();
  const reviewed = file ? isFileReviewed(file.id) : false;
  toggleReviewedButton.textContent = reviewed ? "Reviewed" : "Mark reviewed";
  toggleReviewedButton.className = reviewed
    ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-3 py-1 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25"
    : "cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1 text-xs font-medium text-review-text hover:bg-[#21262d]";
  toggleUnchangedButton.textContent = state.hideUnchanged ? "Show full file" : "Show changed areas only";
  toggleWrapButton.textContent = `Wrap lines: ${state.wrapLines ? "on" : "off"}`;
  submitButton.disabled = false;
}

function applyEditorOptions() {
  if (!diffEditor) return;
  diffEditor.updateOptions({
    diffWordWrap: state.wrapLines ? "on" : "off",
    hideUnchangedRegions: {
      enabled: state.hideUnchanged,
      contextLineCount: 4,
      minimumLineCount: 2,
      revealLineCount: 12,
    },
  });
  diffEditor.getOriginalEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
  diffEditor.getModifiedEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
}

function renderTree() {
  fileTreeEl.innerHTML = "";
  renderTreeNode(buildTree(reviewData.files), 0);
  const comments = state.comments.length;
  summaryEl.textContent = `${reviewData.files.length} file(s) • ${comments} comment(s)${state.overallComment ? " • overall note" : ""}`;
  updateToggleButtons();
}

function showTextModal(options) {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-white">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <textarea id="review-modal-text" class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(options.initialValue ?? "")}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="review-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Cancel</button>
        <button id="review-modal-save" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-4 py-2 text-sm font-medium text-white hover:bg-[#2ea043]">${escapeHtml(options.saveLabel ?? "Save")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textarea = backdrop.querySelector("#review-modal-text");
  const close = () => backdrop.remove();
  backdrop.querySelector("#review-modal-cancel").addEventListener("click", close);
  backdrop.querySelector("#review-modal-save").addEventListener("click", () => {
    options.onSave(textarea.value.trim());
    close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function showOverallCommentModal() {
  showTextModal({
    title: "Overall review note",
    description: "This note is prepended to the generated prompt above the inline comments.",
    initialValue: state.overallComment,
    saveLabel: "Save note",
    onSave: (value) => {
      state.overallComment = value;
      renderTree();
    },
  });
}

function showFileCommentModal() {
  const file = activeFile();
  if (!file) return;
  showTextModal({
    title: `File comment for ${file.displayPath}`,
    description: "This comment applies to the whole file and appears above the diff.",
    initialValue: "",
    saveLabel: "Add comment",
    onSave: (value) => {
      if (!value) return;
      state.comments.push({
        id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
        fileId: file.id,
        side: "file",
        startLine: null,
        endLine: null,
        body: value,
      });
      submitButton.disabled = false;
      updateCommentsUI();
    },
  });
}

function layoutEditor() {
  if (!diffEditor) return;
  const width = editorContainerEl.clientWidth;
  const height = editorContainerEl.clientHeight;
  if (width <= 0 || height <= 0) return;
  diffEditor.layout({ width, height });
}

function clearViewZones() {
  if (!diffEditor || activeViewZones.length === 0) return;
  const original = diffEditor.getOriginalEditor();
  const modified = diffEditor.getModifiedEditor();
  original.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === original) accessor.removeZone(zone.id);
  });
  modified.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === modified) accessor.removeZone(zone.id);
  });
  activeViewZones = [];
}

function renderCommentDOM(comment, onDelete) {
  const container = document.createElement("div");
  container.className = "view-zone-container";
  const title = comment.side === "file"
    ? "File comment"
    : `${comment.side === "original" ? "Original" : "Modified"} line ${comment.startLine}${comment.endLine != null && comment.endLine !== comment.startLine ? `-${comment.endLine}` : ""}`;

  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="text-xs font-semibold text-review-text">${escapeHtml(title)}</div>
      <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-red-500/10 hover:text-red-400">Delete</button>
    </div>
    <textarea data-comment-id="${escapeHtml(comment.id)}" class="scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Leave a comment"></textarea>
  `;
  const textarea = container.querySelector("textarea");
  textarea.value = comment.body || "";
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDelete();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      textarea.blur();
    }
  });
  container.querySelector("[data-action='delete']").addEventListener("click", onDelete);
  if (!comment.body) {
    setTimeout(() => textarea.focus(), 50);
  }
  return container;
}

function deleteLatestEmptyInlineCommentForActiveFile() {
  const file = activeFile();
  if (!file) return false;

  for (let i = state.comments.length - 1; i >= 0; i--) {
    const comment = state.comments[i];
    if (comment.fileId !== file.id) continue;
    if (comment.side === "file") continue;
    if ((comment.body || "").trim().length > 0) continue;
    state.comments.splice(i, 1);
    updateCommentsUI();
    return true;
  }

  return false;
}

function deleteCommentAtCursor() {
  const file = activeFile();
  if (!file || !monacoApi) return false;

  const side = inferActiveSide();
  const editor = getEditorBySide(side);
  if (!editor) return false;

  const line = currentLine(editor);
  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 0; i < state.comments.length; i++) {
    const c = state.comments[i];
    if (c.fileId !== file.id || c.side !== side || c.side === "file") continue;
    const start = c.startLine ?? 0;
    const end = c.endLine ?? start;
    if (line >= start && line <= end) {
      bestIdx = i;
      bestDist = 0;
      break;
    }
    const dist = Math.min(Math.abs(line - start), Math.abs(line - end));
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0 && bestDist <= 3) {
    state.comments.splice(bestIdx, 1);
    updateCommentsUI();
    return true;
  }

  return false;
}

function getEditorBySide(side) {
  if (!diffEditor) return null;
  return side === "original" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
}

function inferActiveSide() {
  if (!diffEditor) return state.vim.side;
  const original = diffEditor.getOriginalEditor();
  const modified = diffEditor.getModifiedEditor();
  if (original.hasTextFocus()) return "original";
  if (modified.hasTextFocus()) return "modified";
  return state.vim.side;
}

function clampLine(editor, line) {
  const lineCount = editor.getModel()?.getLineCount?.() ?? 1;
  return Math.max(1, Math.min(lineCount, line));
}

function currentLine(editor) {
  const pos = editor.getPosition();
  return clampLine(editor, pos?.lineNumber ?? 1);
}

function clearVisualSelection() {
  const side = state.vim.side;
  const editor = getEditorBySide(side);
  if (!editor || !monacoApi) return;
  const line = currentLine(editor);
  editor.setSelection(new monacoApi.Selection(line, 1, line, 1));
  state.vim.visualAnchor = null;
}

function moveCursor(delta) {
  const side = inferActiveSide();
  state.vim.side = side;
  const editor = getEditorBySide(side);
  if (!editor || !monacoApi) return;

  const from = currentLine(editor);
  const to = clampLine(editor, from + delta);

  if (state.vim.visualAnchor != null) {
    editor.setSelection(new monacoApi.Selection(state.vim.visualAnchor, 1, to, 1));
  } else {
    editor.setPosition({ lineNumber: to, column: 1 });
    editor.setSelection(new monacoApi.Selection(to, 1, to, 1));
  }

  editor.revealLineInCenter(to);
  editor.focus();
}

function toggleVisualMode() {
  const side = inferActiveSide();
  state.vim.side = side;
  const editor = getEditorBySide(side);
  if (!editor) return;

  if (state.vim.visualAnchor == null) {
    state.vim.visualAnchor = currentLine(editor);
  } else {
    clearVisualSelection();
  }
}

function addCommentFromKeyboard() {
  const file = activeFile();
  if (!file || !monacoApi) return;

  const side = inferActiveSide();
  state.vim.side = side;
  const editor = getEditorBySide(side);
  if (!editor) return;

  const selection = editor.getSelection();
  let startLine = currentLine(editor);
  let endLine = startLine;

  if (selection && !selection.isEmpty()) {
    startLine = Math.min(selection.startLineNumber, selection.endLineNumber);
    endLine = Math.max(selection.startLineNumber, selection.endLineNumber);
  } else if (state.vim.visualAnchor != null) {
    startLine = Math.min(state.vim.visualAnchor, startLine);
    endLine = Math.max(state.vim.visualAnchor, startLine);
  }

  state.comments.push({
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    fileId: file.id,
    side,
    startLine,
    endLine,
    body: "",
  });

  state.vim.visualAnchor = null;
  updateCommentsUI();
  editor.revealLineInCenter(startLine);
}

function focusSide(side) {
  state.vim.side = side;
  const editor = getEditorBySide(side);
  if (!editor || !monacoApi) return;

  const line = currentLine(editor);
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.setSelection(new monacoApi.Selection(line, 1, line, 1));
  editor.revealLineInCenter(line);
  editor.focus();
}

function toggleFocusedSide() {
  const current = inferActiveSide();
  focusSide(current === "original" ? "modified" : "original");
}

function goToBeginning() {
  const side = inferActiveSide();
  state.vim.side = side;
  const editor = getEditorBySide(side);
  if (!editor || !monacoApi) return;

  state.vim.visualAnchor = null;
  editor.setPosition({ lineNumber: 1, column: 1 });
  editor.setSelection(new monacoApi.Selection(1, 1, 1, 1));
  editor.revealLine(1);
  editor.focus();
}

function goToEnd() {
  const side = inferActiveSide();
  state.vim.side = side;
  const editor = getEditorBySide(side);
  if (!editor || !monacoApi) return;

  const lineCount = editor.getModel()?.getLineCount?.() ?? 1;
  state.vim.visualAnchor = null;
  editor.setPosition({ lineNumber: lineCount, column: 1 });
  editor.setSelection(new monacoApi.Selection(lineCount, 1, lineCount, 1));
  editor.revealLine(lineCount);
  editor.focus();
}

function goToNextHunk() {
  if (!diffEditor) return;
  const changes = diffEditor.getLineChanges() || [];
  if (changes.length === 0) return;

  const side = inferActiveSide();
  state.vim.side = side;
  const editor = getEditorBySide(side);
  if (!editor) return;

  const line = currentLine(editor);
  for (const change of changes) {
    const hunkLine = side === "original"
      ? (change.originalStartLineNumber ?? 1)
      : (change.modifiedStartLineNumber ?? 1);
    if (hunkLine > line) {
      state.vim.visualAnchor = null;
      editor.setPosition({ lineNumber: hunkLine, column: 1 });
      editor.setSelection(new monacoApi.Selection(hunkLine, 1, hunkLine, 1));
      editor.revealLineInCenter(hunkLine);
      editor.focus();
      return;
    }
  }

  const first = changes[0];
  const firstLine = side === "original"
    ? (first.originalStartLineNumber ?? 1)
    : (first.modifiedStartLineNumber ?? 1);
  state.vim.visualAnchor = null;
  editor.setPosition({ lineNumber: firstLine, column: 1 });
  editor.setSelection(new monacoApi.Selection(firstLine, 1, firstLine, 1));
  editor.revealLineInCenter(firstLine);
  editor.focus();
}

function goToPrevHunk() {
  if (!diffEditor) return;
  const changes = diffEditor.getLineChanges() || [];
  if (changes.length === 0) return;

  const side = inferActiveSide();
  state.vim.side = side;
  const editor = getEditorBySide(side);
  if (!editor) return;

  const line = currentLine(editor);
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    const hunkLine = side === "original"
      ? (change.originalStartLineNumber ?? 1)
      : (change.modifiedStartLineNumber ?? 1);
    if (hunkLine < line) {
      state.vim.visualAnchor = null;
      editor.setPosition({ lineNumber: hunkLine, column: 1 });
      editor.setSelection(new monacoApi.Selection(hunkLine, 1, hunkLine, 1));
      editor.revealLineInCenter(hunkLine);
      editor.focus();
      return;
    }
  }

  const last = changes[changes.length - 1];
  const lastLine = side === "original"
    ? (last.originalStartLineNumber ?? 1)
    : (last.modifiedStartLineNumber ?? 1);
  state.vim.visualAnchor = null;
  editor.setPosition({ lineNumber: lastLine, column: 1 });
  editor.setSelection(new monacoApi.Selection(lastLine, 1, lastLine, 1));
  editor.revealLineInCenter(lastLine);
  editor.focus();
}

function getVisualFileOrder() {
  const ordered = [];
  function walk(node) {
    const children = [...node.children.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of children) {
      if (child.kind === "dir") {
        if (state.collapsedDirs[child.path] !== true) {
          walk(child);
        }
      } else if (child.file) {
        ordered.push(child.file);
      }
    }
  }
  walk(buildTree(reviewData.files));
  return ordered;
}

function switchFile(delta) {
  const files = getVisualFileOrder();
  if (files.length === 0) return;

  const currentIndex = files.findIndex((f) => f.id === state.activeFileId);
  let nextIndex = currentIndex + delta;
  if (nextIndex < 0) nextIndex = files.length - 1;
  if (nextIndex >= files.length) nextIndex = 0;

  saveCurrentScrollPosition();
  state.activeFileId = files[nextIndex].id;
  state.vim.visualAnchor = null;
  renderAll({ restoreFileScroll: true });
}

function toggleSidebar() {
  document.getElementById("app-grid").classList.toggle("sidebar-hidden");
}

function showHelpOverlay() {
  const existing = document.getElementById("vim-help-overlay");
  if (existing) { existing.remove(); return; }

  const backdrop = document.createElement("div");
  backdrop.id = "vim-help-overlay";
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card" style="max-width: 560px;">
      <div class="mb-4 text-base font-semibold text-white">Keyboard shortcuts</div>
      <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; font-size: 12px;">
        <span style="color: #facc15; font-family: monospace;">j / k</span><span style="color: #c9d1d9;">Move cursor down / up</span>
        <span style="color: #facc15; font-family: monospace;">Ctrl-d / Ctrl-u</span><span style="color: #c9d1d9;">Half-page down / up</span>
        <span style="color: #facc15; font-family: monospace;">gg</span><span style="color: #c9d1d9;">Go to beginning of file</span>
        <span style="color: #facc15; font-family: monospace;">G</span><span style="color: #c9d1d9;">Go to end of file</span>
        <span style="color: #facc15; font-family: monospace;">n / Ctrl-n / ]c</span><span style="color: #c9d1d9;">Next change hunk</span>
        <span style="color: #facc15; font-family: monospace;">p / Ctrl-p / [c</span><span style="color: #c9d1d9;">Previous change hunk</span>
        <span style="color: #facc15; font-family: monospace;">v</span><span style="color: #c9d1d9;">Toggle visual line selection</span>
        <span style="color: #facc15; font-family: monospace;">a</span><span style="color: #c9d1d9;">Add comment on selection</span>
        <span style="color: #facc15; font-family: monospace;">dd / x</span><span style="color: #c9d1d9;">Delete comment at cursor</span>
        <span style="color: #facc15; font-family: monospace;">Esc</span><span style="color: #c9d1d9;">Cancel selection / delete empty draft</span>
        <span style="color: #facc15; font-family: monospace;">h / l</span><span style="color: #c9d1d9;">Focus original / modified pane</span>
        <span style="color: #facc15; font-family: monospace;">Tab</span><span style="color: #c9d1d9;">Toggle focused pane</span>
        <span style="color: #facc15; font-family: monospace;">J / K</span><span style="color: #c9d1d9;">Next / previous file</span>
        <span style="color: #facc15; font-family: monospace;">r</span><span style="color: #c9d1d9;">Mark file reviewed</span>
        <span style="color: #facc15; font-family: monospace;">o</span><span style="color: #c9d1d9;">Overall note</span>
        <span style="color: #facc15; font-family: monospace;">Enter</span><span style="color: #c9d1d9;">Submit review</span>
        <span style="color: #facc15; font-family: monospace;">Ctrl-Enter</span><span style="color: #c9d1d9;">Submit review</span>
        <span style="color: #facc15; font-family: monospace;">b</span><span style="color: #c9d1d9;">Toggle sidebar</span>
        <span style="color: #facc15; font-family: monospace;">q</span><span style="color: #c9d1d9;">Cancel review</span>
        <span style="color: #facc15; font-family: monospace;">?</span><span style="color: #c9d1d9;">Toggle this help</span>
      </div>
      <div class="mt-4 flex justify-end">
        <button id="vim-help-close" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#vim-help-close").addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
}

function syncViewZones() {
  clearViewZones();
  if (!diffEditor) return;
  const file = activeFile();
  if (!file) return;

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const inlineComments = state.comments.filter((c) => c.fileId === file.id && c.side !== "file");

  inlineComments.forEach((item) => {
    const editor = item.side === "original" ? originalEditor : modifiedEditor;
    const domNode = renderCommentDOM(item, () => {
      state.comments = state.comments.filter((c) => c.id !== item.id);
      updateCommentsUI();
    });

    editor.changeViewZones((accessor) => {
      const lineCount = typeof item.body === "string" && item.body.length > 0 ? item.body.split("\n").length : 1;
      const id = accessor.addZone({
        afterLineNumber: item.endLine ?? item.startLine,
        heightInPx: Math.max(150, lineCount * 22 + 86),
        domNode,
      });
      activeViewZones.push({ id, editor });
    });
  });
}

function updateDecorations() {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  const comments = file ? state.comments.filter((comment) => comment.fileId === file.id && comment.side !== "file") : [];
  const originalRanges = [];
  const modifiedRanges = [];

  for (const comment of comments) {
    const endLine = comment.endLine != null ? comment.endLine : comment.startLine;
    const range = {
      range: new monacoApi.Range(comment.startLine, 1, endLine, 1),
      options: {
        isWholeLine: true,
        className: comment.side === "original" ? "review-comment-line-original" : "review-comment-line-modified",
        glyphMarginClassName: comment.side === "original" ? "review-comment-glyph-original" : "review-comment-glyph-modified",
      },
    };
    if (comment.side === "original") originalRanges.push(range);
    else modifiedRanges.push(range);
  }

  originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, originalRanges);
  modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, modifiedRanges);
}

function renderFileComments() {
  fileCommentsContainer.innerHTML = "";
  const file = activeFile();
  if (!file) return;

  const fileComments = state.comments.filter((c) => c.fileId === file.id && c.side === "file");

  if (fileComments.length > 0) {
    fileCommentsContainer.className = "border-b border-review-border bg-[#0d1117] px-4 py-4 space-y-4";
  } else {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  fileComments.forEach((comment) => {
    const dom = renderCommentDOM(comment, () => {
      state.comments = state.comments.filter((c) => c.id !== comment.id);
      updateCommentsUI();
    });
    dom.className = "rounded-lg border border-review-border bg-review-panel p-4";
    fileCommentsContainer.appendChild(dom);
  });
}

function mountFile(options = {}) {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  if (!file) return;

  const preserveScroll = options.preserveScroll === true;
  const scrollState = preserveScroll ? captureScrollState() : null;

  clearViewZones();
  currentFileLabelEl.textContent = file.displayPath;
  const language = inferLanguage(file.newPath || file.oldPath || file.displayPath);

  if (originalModel) originalModel.dispose();
  if (modifiedModel) modifiedModel.dispose();

  originalModel = monacoApi.editor.createModel(file.oldContent, language);
  modifiedModel = monacoApi.editor.createModel(file.newContent, language);

  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  applyEditorOptions();

  syncViewZones();
  updateDecorations();
  renderFileComments();
  requestAnimationFrame(() => {
    layoutEditor();
    if (options.restoreFileScroll) restoreFileScrollPosition();
    if (options.preserveScroll) restoreScrollState(scrollState);
    setTimeout(() => {
      layoutEditor();
      if (options.restoreFileScroll) restoreFileScrollPosition();
      if (options.preserveScroll) restoreScrollState(scrollState);
    }, 50);
  });
}

function syncCommentBodiesFromDOM() {
  const textareas = document.querySelectorAll("textarea[data-comment-id]");
  textareas.forEach((textarea) => {
    const commentId = textarea.getAttribute("data-comment-id");
    const comment = state.comments.find((item) => item.id === commentId);
    if (comment) {
      comment.body = textarea.value;
    }
  });
}

function updateCommentsUI() {
  renderTree();
  syncViewZones();
  updateDecorations();
  renderFileComments();
}

function renderAll(options = {}) {
  renderTree();
  submitButton.disabled = false;
  if (diffEditor && monacoApi) {
    mountFile(options);
    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
    });
  } else {
    renderFileComments();
  }
}

function createGlyphHoverActions(editor, side) {
  let hoverDecoration = [];

  function openDraftAtLine(line) {
    const file = activeFile();
    if (!file) return;

    let startLine = line;
    let endLine = line;
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      const selStart = Math.min(selection.startLineNumber, selection.endLineNumber);
      const selEnd = Math.max(selection.startLineNumber, selection.endLineNumber);
      if (line >= selStart && line <= selEnd) {
        startLine = selStart;
        endLine = selEnd;
      }
    }

    state.comments.push({
      id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
      fileId: file.id,
      side,
      startLine,
      endLine,
      body: "",
    });
    updateCommentsUI();
    editor.revealLineInCenter(startLine);
  }

  editor.onMouseMove((event) => {
    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      hoverDecoration = editor.deltaDecorations(hoverDecoration, [{
        range: new monacoApi.Range(line, 1, line, 1),
        options: { glyphMarginClassName: "review-glyph-plus" }
      }]);
    } else {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
    }
  });

  editor.onMouseLeave(() => {
    hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
  });

  editor.onMouseDown((event) => {
    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      openDraftAtLine(line);
    }
  });
}

function setupMonaco() {
  window.require.config({
    paths: {
      vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs",
    },
  });

  window.require(["vs/editor/editor.main"], function () {
    monacoApi = window.monaco;

    monacoApi.editor.defineTheme("review-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0d1117",
        "editorCursor.foreground": "#facc15",
        "diffEditor.insertedTextBackground": "#2ea04326",
        "diffEditor.removedTextBackground": "#f8514926",
      }
    });
    monacoApi.editor.setTheme("review-dark");

    diffEditor = monacoApi.editor.createDiffEditor(editorContainerEl, {
      automaticLayout: true,
      renderSideBySide: true,
      readOnly: true,
      originalEditable: false,
      minimap: { enabled: true, renderCharacters: false, showSlider: "always", size: "proportional" },
      renderOverviewRuler: true,
      diffWordWrap: "on",
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      glyphMargin: true,
      folding: true,
      lineDecorationsWidth: 10,
      overviewRulerBorder: false,
      wordWrap: "on",
      cursorStyle: "block",
      cursorBlinking: "solid",
      renderLineHighlight: "all",
      fontFamily: "Typestar OCR, OCR A Std, OCR A Extended, JetBrains Mono, Fira Code, monospace",
      fontSize: 12,
    });

    diffEditor.getOriginalEditor().updateOptions({
      cursorStyle: "block",
      cursorBlinking: "solid",
      renderLineHighlight: "all",
    });
    diffEditor.getModifiedEditor().updateOptions({
      cursorStyle: "block",
      cursorBlinking: "solid",
      renderLineHighlight: "all",
    });

    createGlyphHoverActions(diffEditor.getOriginalEditor(), "original");
    createGlyphHoverActions(diffEditor.getModifiedEditor(), "modified");

    if (typeof ResizeObserver !== "undefined") {
      editorResizeObserver = new ResizeObserver(() => {
        layoutEditor();
      });
      editorResizeObserver.observe(editorContainerEl);
    }

    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
      setTimeout(layoutEditor, 150);
    });

    mountFile();
  });
}

submitButton.addEventListener("click", () => {
  syncCommentBodiesFromDOM();
  const payload = {
    type: "submit",
    overallComment: state.overallComment.trim(),
    comments: state.comments.map((comment) => ({ ...comment, body: comment.body.trim() })).filter((comment) => comment.body.length > 0),
  };
  window.glimpse.send(payload);
  window.glimpse.close();
});

cancelButton.addEventListener("click", () => {
  window.glimpse.send({ type: "cancel" });
  window.glimpse.close();
});

overallCommentButton.addEventListener("click", () => {
  showOverallCommentModal();
});

fileCommentButton.addEventListener("click", () => {
  showFileCommentModal();
});

toggleUnchangedButton.addEventListener("click", () => {
  state.hideUnchanged = !state.hideUnchanged;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(layoutEditor);
});

toggleWrapButton.addEventListener("click", () => {
  state.wrapLines = !state.wrapLines;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
});

toggleReviewedButton.addEventListener("click", () => {
  const file = activeFile();
  if (!file) return;
  state.reviewedFiles[file.id] = !isFileReviewed(file.id);
  renderTree();
});

renderTree();
renderFileComments();
setupMonaco();

const keyDebugOverlay = document.getElementById("key-debug-overlay");
const keyDebugLog = document.getElementById("key-debug-log");
const KEY_DEBUG_MAX = 20;

function isKeyDebugActive() {
  return keyDebugOverlay.classList.contains("active");
}

function toggleKeyDebug() {
  keyDebugOverlay.classList.toggle("active");
  if (!isKeyDebugActive()) {
    keyDebugLog.innerHTML = "";
  }
}

function logKeyEvent(keyLabel, action, blocked) {
  if (!isKeyDebugActive()) return;

  const now = new Date();
  const ts = `${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;

  const entry = document.createElement("div");
  entry.className = "key-entry";
  entry.innerHTML = `<span class="key-name">${escapeHtml(keyLabel)}</span><span class="${blocked ? "key-blocked" : "key-action"}">${escapeHtml(action)}</span><span class="key-time">${ts}</span>`;

  keyDebugLog.insertBefore(entry, keyDebugLog.firstChild);

  while (keyDebugLog.children.length > KEY_DEBUG_MAX) {
    keyDebugLog.removeChild(keyDebugLog.lastChild);
  }
}

function formatKeyLabel(event) {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.metaKey) parts.push("Cmd");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.key);
  return parts.join("+");
}

window.addEventListener("keydown", (event) => {
  const target = event.target;
  const isElement = target instanceof HTMLElement;
  const inMonaco = isElement && target.closest(".monaco-editor") != null;
  const isMonacoHiddenInput = isElement && target.classList.contains("inputarea");
  const inCommentInput = isElement && (
    (target.tagName === "TEXTAREA" && !isMonacoHiddenInput) ||
    target.tagName === "INPUT" ||
    (target.isContentEditable && !inMonaco)
  );

  const keyLabel = formatKeyLabel(event);

  if (event.key === "D" && event.ctrlKey && event.shiftKey) {
    event.preventDefault();
    toggleKeyDebug();
    return;
  }

  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    logKeyEvent(keyLabel, "submit (Ctrl-Enter)", false);
    submitButton.click();
    return;
  }

  if (inCommentInput) return;

  // Handle two-key sequences: gg, ]c, [c
  if (state.vim.pendingKey != null) {
    const combo = state.vim.pendingKey + event.key;
    state.vim.pendingKey = null;

    if (combo === "gg") {
      event.preventDefault();
      logKeyEvent(combo, "go to beginning", false);
      goToBeginning();
      return;
    }
    if (combo === "dd") {
      event.preventDefault();
      const deleted = deleteCommentAtCursor();
      logKeyEvent(combo, deleted ? "delete comment" : "no comment nearby", !deleted);
      return;
    }
    if (combo === "]c") {
      event.preventDefault();
      logKeyEvent(combo, "next hunk", false);
      goToNextHunk();
      return;
    }
    if (combo === "[c") {
      event.preventDefault();
      logKeyEvent(combo, "prev hunk", false);
      goToPrevHunk();
      return;
    }
    logKeyEvent(combo, "unknown combo", true);
  }

  // Start pending sequences
  if (event.key === "g" && !event.ctrlKey && !event.metaKey) {
    state.vim.pendingKey = "g";
    logKeyEvent(keyLabel, "pending: g...", false);
    event.preventDefault();
    return;
  }
  if (event.key === "d" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    state.vim.pendingKey = "d";
    logKeyEvent(keyLabel, "pending: d...", false);
    event.preventDefault();
    return;
  }
  if (event.key === "]" && !event.ctrlKey && !event.metaKey) {
    state.vim.pendingKey = "]";
    logKeyEvent(keyLabel, "pending: ]...", false);
    event.preventDefault();
    return;
  }
  if (event.key === "[" && !event.ctrlKey && !event.metaKey) {
    state.vim.pendingKey = "[";
    logKeyEvent(keyLabel, "pending: [...", false);
    event.preventDefault();
    return;
  }

  if (event.key === "G" && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "go to end", false);
    goToEnd();
    return;
  }
  if (event.key === "j" && !event.shiftKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "cursor down", false);
    moveCursor(1);
    return;
  }
  if (event.key === "k" && !event.shiftKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "cursor up", false);
    moveCursor(-1);
    return;
  }
  if (event.key === "J") {
    event.preventDefault();
    logKeyEvent(keyLabel, "next file", false);
    switchFile(1);
    return;
  }
  if (event.key === "K") {
    event.preventDefault();
    logKeyEvent(keyLabel, "prev file", false);
    switchFile(-1);
    return;
  }
  if (event.ctrlKey && (event.key === "d" || event.key === "u")) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const action = event.key === "d" ? "half-page down" : "half-page up";
    logKeyEvent(keyLabel, action, false);
    moveCursor(event.key === "d" ? 12 : -12);
    return;
  }
  if (event.key === "n" && event.ctrlKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "next hunk", false);
    goToNextHunk();
    return;
  }
  if (event.key === "p" && event.ctrlKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "prev hunk", false);
    goToPrevHunk();
    return;
  }
  if (event.key === "x" && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    const deleted = deleteCommentAtCursor();
    logKeyEvent(keyLabel, deleted ? "delete comment" : "no comment nearby", !deleted);
    return;
  }
  if (event.key === "n" && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "next hunk", false);
    goToNextHunk();
    return;
  }
  if (event.key === "p" && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "prev hunk", false);
    goToPrevHunk();
    return;
  }
  if (event.key === "v") {
    event.preventDefault();
    logKeyEvent(keyLabel, "visual toggle", false);
    toggleVisualMode();
    return;
  }
  if (event.key === "a") {
    event.preventDefault();
    logKeyEvent(keyLabel, "add comment", false);
    addCommentFromKeyboard();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    logKeyEvent(keyLabel, "toggle pane", false);
    toggleFocusedSide();
    return;
  }
  if (event.key === "h" && !event.shiftKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "focus original", false);
    focusSide("original");
    return;
  }
  if (event.key === "l" && !event.shiftKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "focus modified", false);
    focusSide("modified");
    return;
  }
  if (event.key === "r" && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "mark reviewed", false);
    toggleReviewedButton.click();
    return;
  }
  if (event.key === "o" && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "overall note", false);
    showOverallCommentModal();
    return;
  }
  if (event.key === "q" && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "cancel review", false);
    cancelButton.click();
    return;
  }
  if (event.key === "b" && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    logKeyEvent(keyLabel, "toggle sidebar", false);
    toggleSidebar();
    return;
  }
  if (event.key === "?") {
    event.preventDefault();
    logKeyEvent(keyLabel, "show help", false);
    showHelpOverlay();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    logKeyEvent(keyLabel, "submit", false);
    submitButton.click();
    return;
  }
  if (event.key === "Escape") {
    const helpOverlay = document.getElementById("vim-help-overlay");
    if (helpOverlay) { logKeyEvent(keyLabel, "close help", false); helpOverlay.remove(); return; }
    if (deleteLatestEmptyInlineCommentForActiveFile()) {
      event.preventDefault();
      logKeyEvent(keyLabel, "delete draft", false);
      return;
    }
    logKeyEvent(keyLabel, "clear visual", false);
    state.vim.visualAnchor = null;
    return;
  }

  logKeyEvent(keyLabel, "unhandled", true);
}, true);
