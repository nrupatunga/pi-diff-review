import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { DiffReviewComment, DiffReviewFile } from "./types.js";
import { getRepoRoot, getDiffReviewFiles, type BranchCompareOptions } from "./git.js";

interface GitHubPRComment {
  path: string;
  line: number | null;
  start_line: number | null;
  side: string;
  body: string;
  user: { login: string };
}

interface GitHubPRInfo {
  baseRefName: string;
  headRefName: string;
  number: number;
  title: string;
}

async function runGh(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  const result = await pi.exec("gh", args, { cwd });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `gh ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

export async function getPRInfo(pi: ExtensionAPI, cwd: string, prNumber: string): Promise<GitHubPRInfo> {
  const output = await runGh(pi, cwd, [
    "pr", "view", prNumber, "--json", "baseRefName,headRefName,number,title",
  ]);
  return JSON.parse(output) as GitHubPRInfo;
}

export async function getPRFiles(
  pi: ExtensionAPI,
  cwd: string,
  prNumber: string,
): Promise<{ repoRoot: string; files: DiffReviewFile[]; branchCompare: BranchCompareOptions; prTitle: string }> {
  const repoRoot = await getRepoRoot(pi, cwd);

  // Fetch to ensure remote refs are up to date
  await pi.exec("git", ["fetch", "origin"], { cwd: repoRoot }).catch(() => {});

  const prInfo = await getPRInfo(pi, cwd, prNumber);
  const branchCompare: BranchCompareOptions = {
    branch1: `origin/${prInfo.baseRefName}`,
    branch2: `origin/${prInfo.headRefName}`,
  };

  const { files } = await getDiffReviewFiles(pi, cwd, branchCompare);

  return { repoRoot, files, branchCompare, prTitle: prInfo.title };
}

export async function getPRComments(
  pi: ExtensionAPI,
  cwd: string,
  prNumber: string,
  files: DiffReviewFile[],
): Promise<DiffReviewComment[]> {
  const output = await runGh(pi, cwd, [
    "api", `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
    "--paginate",
  ]);

  if (!output.trim()) return [];

  let rawComments: GitHubPRComment[];
  try {
    rawComments = JSON.parse(output) as GitHubPRComment[];
  } catch {
    return [];
  }

  const fileByPath = new Map<string, DiffReviewFile>();
  for (const file of files) {
    if (file.newPath) fileByPath.set(file.newPath, file);
    if (file.oldPath) fileByPath.set(file.oldPath, file);
  }

  const comments: DiffReviewComment[] = [];

  for (const raw of rawComments) {

    const file = fileByPath.get(raw.path);
    if (!file) continue;

    const endLine = raw.line ?? null;
    const startLine = raw.start_line ?? endLine;
    const side = raw.side === "LEFT" ? "original" as const : "modified" as const;
    const author = raw.user?.login ?? "unknown";

    comments.push({
      id: `pr:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      fileId: file.id,
      side,
      startLine,
      endLine,
      body: `[${author}]: ${raw.body}`,
      author,
    });
  }

  return comments;
}
