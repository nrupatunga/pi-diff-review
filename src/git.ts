import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ChangeStatus, DiffReviewFile } from "./types.js";

const MAX_FILE_CHARS = 250_000;
const MAX_TOTAL_CHARS = 2_000_000;
const MAX_READ_BYTES = 1_000_000;

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff", ".heic", ".svgz",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v",
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".so", ".dll", ".dylib", ".exe", ".bin", ".o", ".a", ".class", ".jar",
]);

interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runGitAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    throw new Error("Not inside a git repository.");
  }
  return result.stdout.trim();
}

async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
  const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  return result.code === 0;
}

function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: ChangedPath[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0];

    if (code === "R") {
      const oldPath = parts[1] ?? null;
      const newPath = parts[2] ?? null;
      if (oldPath != null && newPath != null) {
        changes.push({ status: "renamed", oldPath, newPath });
      }
      continue;
    }

    if (code === "M") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "modified", oldPath: path, newPath: path });
      }
      continue;
    }

    if (code === "A") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "added", oldPath: null, newPath: path });
      }
      continue;
    }

    if (code === "D") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "deleted", oldPath: path, newPath: null });
      }
    }
  }

  return changes;
}

async function getHeadContent(pi: ExtensionAPI, repoRoot: string, path: string): Promise<string> {
  const lowerPath = path.toLowerCase();
  const dot = lowerPath.lastIndexOf(".");
  const ext = dot >= 0 ? lowerPath.slice(dot) : "";
  if (BINARY_EXTENSIONS.has(ext)) {
    return `/* old content omitted for ${path}: binary extension (${ext}) */`;
  }

  const sizeResult = await pi.exec("git", ["cat-file", "-s", `HEAD:${path}`], { cwd: repoRoot });
  if (sizeResult.code === 0) {
    const size = Number.parseInt(sizeResult.stdout.trim(), 10);
    if (Number.isFinite(size) && size > MAX_READ_BYTES) {
      return `/* old content omitted for ${path}: blob is ${size.toLocaleString()} bytes (> ${MAX_READ_BYTES.toLocaleString()} byte read limit) */`;
    }
  }

  const result = await pi.exec("git", ["show", `HEAD:${path}`], { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    const lowerPath = path.toLowerCase();
    const dot = lowerPath.lastIndexOf(".");
    const ext = dot >= 0 ? lowerPath.slice(dot) : "";
    if (BINARY_EXTENSIONS.has(ext)) {
      return `/* new content omitted for ${path}: binary extension (${ext}) */`;
    }

    const absPath = join(repoRoot, path);
    const fileStat = await stat(absPath);
    if (fileStat.size > MAX_READ_BYTES) {
      return `/* new content omitted for ${path}: file is ${fileStat.size.toLocaleString()} bytes (> ${MAX_READ_BYTES.toLocaleString()} byte read limit) */`;
    }

    return await readFile(absPath, "utf8");
  } catch {
    return "";
  }
}

function sanitizeContent(path: string, side: "old" | "new", content: string): string {
  if (content.includes("\u0000")) {
    return `/* ${side} content omitted for ${path}: appears to be binary data */`;
  }

  if (content.length > MAX_FILE_CHARS) {
    const kept = content.slice(0, MAX_FILE_CHARS);
    return `${kept}\n\n/* ${side} content truncated for ${path}: ${content.length.toLocaleString()} chars exceeds ${MAX_FILE_CHARS.toLocaleString()} char limit */`;
  }

  return content;
}

function parseUntrackedPaths(output: string): ChangedPath[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => ({
      status: "added" as const,
      oldPath: null,
      newPath: path,
    }));
}

function mergeChangedPaths(tracked: ChangedPath[], untracked: ChangedPath[]): ChangedPath[] {
  const seen = new Set(tracked.map((change) => `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`));
  const merged = [...tracked];

  for (const change of untracked) {
    const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
    if (seen.has(key)) continue;
    merged.push(change);
    seen.add(key);
  }

  return merged;
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") {
    return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

export async function getDiffReviewFiles(pi: ExtensionAPI, cwd: string): Promise<{ repoRoot: string; files: DiffReviewFile[] }> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const repositoryHasHead = await hasHead(pi, repoRoot);

  const trackedOutput = repositoryHasHead
    ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"])
    : "";
  const untrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]);

  const trackedPaths = parseNameStatus(trackedOutput);
  const untrackedPaths = parseUntrackedPaths(untrackedOutput);
  const changedPaths = mergeChangedPaths(trackedPaths, untrackedPaths);

  let totalChars = 0;
  const files = await Promise.all(
    changedPaths.map(async (change, index): Promise<DiffReviewFile> => {
      const displayPath = toDisplayPath(change);
      const rawOldContent = change.oldPath == null ? "" : await getHeadContent(pi, repoRoot, change.oldPath);
      const rawNewContent = change.newPath == null ? "" : await getWorkingTreeContent(repoRoot, change.newPath);
      let oldContent = sanitizeContent(displayPath, "old", rawOldContent);
      let newContent = sanitizeContent(displayPath, "new", rawNewContent);

      const prospectiveTotal = totalChars + oldContent.length + newContent.length;
      if (prospectiveTotal > MAX_TOTAL_CHARS) {
        oldContent = `/* old content omitted for ${displayPath}: review payload exceeded ${MAX_TOTAL_CHARS.toLocaleString()} chars */`;
        newContent = `/* new content omitted for ${displayPath}: review payload exceeded ${MAX_TOTAL_CHARS.toLocaleString()} chars */`;
      }

      totalChars += oldContent.length + newContent.length;

      return {
        id: `${index}:${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`,
        status: change.status,
        oldPath: change.oldPath,
        newPath: change.newPath,
        displayPath,
        oldContent,
        newContent,
      };
    }),
  );

  return { repoRoot, files };
}
