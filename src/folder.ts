import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BINARY_EXTENSIONS,
  IGNORED_PREFIXES,
  MAX_FILES,
  MAX_READ_BYTES,
  sanitizeContent,
} from "./git.js";
import type { ChangeStatus, DiffReviewFile, DiffReviewFileContents } from "./types.js";

export interface FolderCompareOptions {
  left: string;
  right: string;
}

type FolderChange = {
  status: Exclude<ChangeStatus, "renamed">;
  path: string;
};

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];

  async function recurse(dir: string, relPrefix: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const rel = relPrefix.length === 0 ? name : `${relPrefix}/${name}`;
      if (IGNORED_PREFIXES.some((prefix) => rel.startsWith(prefix) || rel === prefix.replace(/\/$/, ""))) {
        continue;
      }
      // Skip symlinks to avoid cycles and accidental escapes from the compare root.
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, name);
      if (entry.isDirectory()) {
        await recurse(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }

  await recurse(root, "");
  return out;
}

async function filesDiffer(leftAbs: string, rightAbs: string): Promise<boolean> {
  const [lStat, rStat] = await Promise.all([
    stat(leftAbs).catch(() => null),
    stat(rightAbs).catch(() => null),
  ]);
  if (lStat == null || rStat == null) return true;
  if (lStat.size !== rStat.size) return true;

  // If both files exceed the read limit, we can't cheaply compare bytes — assume modified so
  // reviewers can see the truncation notices instead of silently dropping the file from the list.
  if (lStat.size > MAX_READ_BYTES) return true;

  const [lBuf, rBuf] = await Promise.all([readFile(leftAbs), readFile(rightAbs)]);
  return Buffer.compare(lBuf, rBuf) !== 0;
}

async function readForSide(
  abs: string,
  displayPath: string,
  side: "old" | "new",
): Promise<string> {
  const lower = displayPath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  if (BINARY_EXTENSIONS.has(ext)) {
    return `/* ${side} content omitted for ${displayPath}: binary extension (${ext}) */`;
  }

  try {
    const s = await stat(abs);
    if (s.size > MAX_READ_BYTES) {
      return `/* ${side} content omitted for ${displayPath}: file is ${s.size.toLocaleString()} bytes (> ${MAX_READ_BYTES.toLocaleString()} byte read limit) */`;
    }
    return await readFile(abs, "utf8");
  } catch {
    return "";
  }
}

export async function assertDirectory(path: string, label: string): Promise<void> {
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} path not accessible: ${message}`);
  }
  if (!s.isDirectory()) {
    throw new Error(`${label} path is not a directory: ${path}`);
  }
}

export async function getFolderDiffReviewFiles(
  options: FolderCompareOptions,
): Promise<{ files: DiffReviewFile[] }> {
  const { left, right } = options;

  const [leftPaths, rightPaths] = await Promise.all([walk(left), walk(right)]);

  const leftSet = new Set(leftPaths);
  const rightSet = new Set(rightPaths);
  const union = new Set<string>([...leftPaths, ...rightPaths]);
  const ordered = [...union].sort((a, b) => a.localeCompare(b));

  const changes: FolderChange[] = [];

  for (const rel of ordered) {
    const inLeft = leftSet.has(rel);
    const inRight = rightSet.has(rel);
    if (inLeft && !inRight) {
      changes.push({ status: "deleted", path: rel });
    } else if (!inLeft && inRight) {
      changes.push({ status: "added", path: rel });
    } else if (inLeft && inRight) {
      if (await filesDiffer(join(left, rel), join(right, rel))) {
        changes.push({ status: "modified", path: rel });
      }
    }
  }

  const trimmed = changes.slice(0, MAX_FILES);

  const files: DiffReviewFile[] = trimmed.map((change, index) => {
    const oldPath = change.status === "added" ? null : change.path;
    const newPath = change.status === "deleted" ? null : change.path;
    return {
      id: `${index}:${change.status}:${oldPath ?? ""}:${newPath ?? ""}`,
      status: change.status,
      oldPath,
      newPath,
      displayPath: change.path,
    };
  });

  return { files };
}

export async function loadFolderFileContents(
  options: FolderCompareOptions,
  file: DiffReviewFile,
): Promise<DiffReviewFileContents> {
  const oldContentPromise = file.oldPath == null
    ? Promise.resolve("")
    : readForSide(join(options.left, file.oldPath), file.displayPath, "old");
  const newContentPromise = file.newPath == null
    ? Promise.resolve("")
    : readForSide(join(options.right, file.newPath), file.displayPath, "new");

  const [rawOld, rawNew] = await Promise.all([oldContentPromise, newContentPromise]);
  return {
    oldContent: sanitizeContent(file.displayPath, "old", rawOld),
    newContent: sanitizeContent(file.displayPath, "new", rawNew),
  };
}
