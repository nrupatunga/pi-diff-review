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
  url: string;
}

async function runGh(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  const result = await pi.exec("gh", args, { cwd });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `gh ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

function repoFromPRUrl(url: string): string | null {
  // https://github.com/owner/repo/pull/123
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
  return match ? match[1] : null;
}

async function detectRepo(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  // Try origin remote URL to detect owner/repo
  const result = await pi.exec("git", ["remote", "get-url", "origin"], { cwd });
  if (result.code !== 0) return null;
  const url = result.stdout.trim();
  // Match github.com/owner/repo from https or ssh URLs
  const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return match ? match[1] : null;
}

export async function getPRInfo(pi: ExtensionAPI, cwd: string, prNumber: string): Promise<GitHubPRInfo> {
  const repo = await detectRepo(pi, cwd);
  const args = ["pr", "view", prNumber, "--json", "baseRefName,headRefName,number,title,url"];
  if (repo) args.push("--repo", repo);
  const output = await runGh(pi, cwd, args);
  return JSON.parse(output) as GitHubPRInfo;
}

export async function getPRFiles(
  pi: ExtensionAPI,
  cwd: string,
  prNumber: string,
): Promise<{ repoRoot: string; files: DiffReviewFile[]; branchCompare: BranchCompareOptions; prTitle: string; prUrl: string }> {
  const repoRoot = await getRepoRoot(pi, cwd);

  const prInfo = await getPRInfo(pi, cwd, prNumber);

  // Fetch base branch and PR head ref (works for forks too)
  await pi.exec("git", ["fetch", "origin", prInfo.baseRefName], { cwd: repoRoot }).catch(() => {});
  await pi.exec("git", ["fetch", "origin", `pull/${prNumber}/head:refs/pr/${prNumber}`], { cwd: repoRoot }).catch(() => {});

  // Use fetched PR ref for head; fall back to origin/<branch> if the PR ref fetch failed
  const prHeadRef = `refs/pr/${prNumber}`;
  const headRefCheck = await pi.exec("git", ["rev-parse", "--verify", prHeadRef], { cwd: repoRoot });
  const headRef = headRefCheck.code === 0 ? prHeadRef : `origin/${prInfo.headRefName}`;

  const branchCompare: BranchCompareOptions = {
    branch1: `origin/${prInfo.baseRefName}`,
    branch2: headRef,
  };

  const { files } = await getDiffReviewFiles(pi, cwd, branchCompare);

  return { repoRoot, files, branchCompare, prTitle: prInfo.title, prUrl: prInfo.url };
}

export async function getPRComments(
  pi: ExtensionAPI,
  cwd: string,
  prNumber: string,
  files: DiffReviewFile[],
  prUrl?: string,
): Promise<DiffReviewComment[]> {
  const repo = prUrl ? repoFromPRUrl(prUrl) : null;
  const apiPath = repo
    ? `repos/${repo}/pulls/${prNumber}/comments`
    : `repos/{owner}/{repo}/pulls/${prNumber}/comments`;

  const output = await runGh(pi, cwd, [
    "api", apiPath,
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
