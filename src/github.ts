import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { DiffReviewComment, DiffReviewFile } from "./types.js";
import { getRepoRoot, getDiffReviewFiles, type BranchCompareOptions } from "./git.js";

interface GitHubPRInfo {
  baseRefName: string;
  headRefName: string;
  number: number;
  title: string;
  state: string;
}

async function runGh(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  const result = await pi.exec("gh", args, { cwd });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `gh ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function detectGitHubRepo(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["remote", "get-url", "origin"], { cwd });
  if (result.code !== 0) {
    throw new Error("No git origin remote found. Is this a GitHub repository?");
  }
  const match = result.stdout.trim().match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (!match) {
    throw new Error("Origin remote is not a GitHub URL.");
  }
  return match[1];
}

export async function getPRData(
  pi: ExtensionAPI,
  cwd: string,
  prNumber: string,
): Promise<{ repoRoot: string; files: DiffReviewFile[]; branchCompare: BranchCompareOptions; prTitle: string; comments: DiffReviewComment[] }> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const repo = await detectGitHubRepo(pi, repoRoot);

  const infoOutput = await runGh(pi, repoRoot, [
    "pr", "view", prNumber, "--repo", repo,
    "--json", "baseRefName,headRefName,number,title,state",
  ]);
  const prInfo = JSON.parse(infoOutput) as GitHubPRInfo;

  if (prInfo.state === "MERGED" || prInfo.state === "CLOSED") {
    throw new Error(`PR #${prNumber} is ${prInfo.state.toLowerCase()}. Only open PRs are supported.`);
  }

  // Run fetches and comment retrieval in parallel
  const [fetchBaseResult, fetchHeadResult, commentsOutput] = await Promise.all([
    pi.exec("git", ["fetch", "origin", prInfo.baseRefName], { cwd: repoRoot }),
    pi.exec("git", ["fetch", "origin", `pull/${prNumber}/head:refs/pr/${prNumber}`], { cwd: repoRoot }),
    runGh(pi, cwd, [
      "api", `repos/${repo}/pulls/${prNumber}/comments`,
      "--paginate",
      "--jq", `.[] | {path, line, start_line, side, body, login: .user.login}`,
    ]).catch(() => ""),
  ]);

  if (fetchBaseResult.code !== 0) {
    throw new Error(`Failed to fetch base branch '${prInfo.baseRefName}' from origin.`);
  }
  if (fetchHeadResult.code !== 0) {
    throw new Error(`Failed to fetch PR #${prNumber} head ref. The PR branch may have been deleted.`);
  }

  const branchCompare: BranchCompareOptions = {
    branch1: `origin/${prInfo.baseRefName}`,
    branch2: `refs/pr/${prNumber}`,
  };

  const { files } = await getDiffReviewFiles(pi, cwd, branchCompare);
  const comments = parseComments(commentsOutput, files);

  return { repoRoot, files, branchCompare, prTitle: prInfo.title, comments };
}

function parseComments(output: string, files: DiffReviewFile[]): DiffReviewComment[] {
  if (!output.trim()) return [];

  const fileByPath = new Map<string, DiffReviewFile>();
  for (const file of files) {
    if (file.newPath) fileByPath.set(file.newPath, file);
    if (file.oldPath) fileByPath.set(file.oldPath, file);
  }

  const comments: DiffReviewComment[] = [];
  for (const line of output.trim().split("\n")) {
    if (!line.trim()) continue;
    let raw: { path: string; line: number | null; start_line: number | null; side: string; body: string; login: string };
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    const file = fileByPath.get(raw.path);
    if (!file) continue;

    const endLine = raw.line ?? null;
    const startLine = raw.start_line ?? endLine;

    // Skip file-level review comments (no line attached) — they can't be placed in the diff
    if (startLine == null) continue;

    comments.push({
      id: `pr:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      fileId: file.id,
      side: raw.side === "LEFT" ? "original" : "modified",
      startLine,
      endLine,
      body: raw.body,
      author: raw.login ?? "unknown",
      fromPR: true,
    });
  }

  return comments;
}
