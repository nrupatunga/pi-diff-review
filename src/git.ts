import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ChangeStatus, DiffReviewFile, DiffReviewFileContents } from "./types.js";

const MAX_FILE_CHARS = 250_000;
const MAX_TOTAL_CHARS = 2_000_000;
const MAX_READ_BYTES = 1_000_000;
const MAX_FILES = 200;

const IGNORED_PREFIXES = [".pi/", "node_modules/", ".git/"];

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

async function getRefContent(pi: ExtensionAPI, repoRoot: string, ref: string, path: string): Promise<string> {
  const lowerPath = path.toLowerCase();
  const dot = lowerPath.lastIndexOf(".");
  const ext = dot >= 0 ? lowerPath.slice(dot) : "";
  if (BINARY_EXTENSIONS.has(ext)) {
    return `/* content omitted for ${path}: binary extension (${ext}) */`;
  }

  const sizeResult = await pi.exec("git", ["cat-file", "-s", `${ref}:${path}`], { cwd: repoRoot });
  if (sizeResult.code === 0) {
    const size = Number.parseInt(sizeResult.stdout.trim(), 10);
    if (Number.isFinite(size) && size > MAX_READ_BYTES) {
      return `/* content omitted for ${path}: blob is ${size.toLocaleString()} bytes (> ${MAX_READ_BYTES.toLocaleString()} byte read limit) */`;
    }
  }

  const result = await pi.exec("git", ["show", `${ref}:${path}`], { cwd: repoRoot });
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

function shouldIncludeChange(change: ChangedPath): boolean {
  const paths = [change.oldPath, change.newPath].filter((p): p is string => p != null);
  return paths.every((p) => !IGNORED_PREFIXES.some((prefix) => p.startsWith(prefix)));
}

export async function listBranches(pi: ExtensionAPI, cwd: string): Promise<{ repoRoot: string; branches: string[] }> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const output = await runGit(pi, repoRoot, ["branch", "-a", "--format=%(refname:short)", "--sort=-committerdate"]);
  const branches = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // skip HEAD pointer aliases like "origin/HEAD"
    .filter((line) => !line.endsWith("/HEAD"));
  return { repoRoot, branches };
}

export interface BranchCompareOptions {
  branch1: string;
  branch2: string;
}

export async function getDiffReviewFiles(
  pi: ExtensionAPI,
  cwd: string,
  branchCompare?: BranchCompareOptions,
): Promise<{ repoRoot: string; files: DiffReviewFile[] }> {
  const repoRoot = await getRepoRoot(pi, cwd);

  let changedPaths: ChangedPath[];

  if (branchCompare != null) {
    // Branch-to-branch comparison
    const { branch1, branch2 } = branchCompare;
    const trackedOutput = await runGit(pi, repoRoot, [
      "diff", "--find-renames", "-M", "--name-status", branch1, branch2, "--",
    ]);
    changedPaths = parseNameStatus(trackedOutput)
      .filter(shouldIncludeChange)
      .slice(0, MAX_FILES);
  } else {
    // Default: working tree vs HEAD
    const repositoryHasHead = await hasHead(pi, repoRoot);
    const trackedOutput = repositoryHasHead
      ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"])
      : "";
    const untrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]);
    const trackedPaths = parseNameStatus(trackedOutput);
    const untrackedPaths = parseUntrackedPaths(untrackedOutput);
    changedPaths = mergeChangedPaths(trackedPaths, untrackedPaths)
      .filter(shouldIncludeChange)
      .slice(0, MAX_FILES);
  }

  const files: DiffReviewFile[] = changedPaths.map((change, index) => ({
    id: `${index}:${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`,
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
  }));

  return { repoRoot, files };
}

export async function loadFileContents(
  pi: ExtensionAPI,
  repoRoot: string,
  file: DiffReviewFile,
  branchCompare?: BranchCompareOptions,
): Promise<DiffReviewFileContents> {
  const oldContentPromise = branchCompare != null
    ? (file.oldPath == null ? Promise.resolve("") : getRefContent(pi, repoRoot, branchCompare.branch1, file.oldPath))
    : (file.oldPath == null ? Promise.resolve("") : getRefContent(pi, repoRoot, "HEAD", file.oldPath));

  const newContentPromise = branchCompare != null
    ? (file.newPath == null ? Promise.resolve("") : getRefContent(pi, repoRoot, branchCompare.branch2, file.newPath))
    : (file.newPath == null ? Promise.resolve("") : getWorkingTreeContent(repoRoot, file.newPath));

  const [rawOldContent, rawNewContent] = await Promise.all([oldContentPromise, newContentPromise]);

  const oldContent = sanitizeContent(file.displayPath, "old", rawOldContent);
  const newContent = sanitizeContent(file.displayPath, "new", rawNewContent);

  return { oldContent, newContent };
}
