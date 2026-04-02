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

async function ensureGh(pi: ExtensionAPI, cwd: string): Promise<void> {
  const result = await pi.exec("gh", ["auth", "status"], { cwd });
  if (result.code !== 0) {
    throw new Error("GitHub CLI (gh) is not installed or not authenticated. Run: gh auth login");
  }
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

export async function getPRFiles(
  pi: ExtensionAPI,
  cwd: string,
  prNumber: string,
): Promise<{ repoRoot: string; files: DiffReviewFile[]; branchCompare: BranchCompareOptions; prTitle: string; repo: string }> {
  await ensureGh(pi, cwd);
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

  // Fetch PR head via pull/<N>/head (works for fork PRs where origin/<branch> doesn't exist)
  const fetchBaseResult = await pi.exec("git", ["fetch", "origin", prInfo.baseRefName], { cwd: repoRoot });
  if (fetchBaseResult.code !== 0) {
    throw new Error(`Failed to fetch base branch '${prInfo.baseRefName}' from origin.`);
  }

  const fetchHeadResult = await pi.exec("git", ["fetch", "origin", `pull/${prNumber}/head:refs/pr/${prNumber}`], { cwd: repoRoot });
  if (fetchHeadResult.code !== 0) {
    throw new Error(`Failed to fetch PR #${prNumber} head ref. The PR branch may have been deleted.`);
  }

  const branchCompare: BranchCompareOptions = {
    branch1: `origin/${prInfo.baseRefName}`,
    branch2: `refs/pr/${prNumber}`,
  };

  const { files } = await getDiffReviewFiles(pi, cwd, branchCompare);
  return { repoRoot, files, branchCompare, prTitle: prInfo.title, repo };
}

export async function getPRComments(
  pi: ExtensionAPI,
  cwd: string,
  repo: string,
  prNumber: string,
  files: DiffReviewFile[],
): Promise<DiffReviewComment[]> {
  // Use --jq to extract only the fields we need and produce compact one-object-per-line output.
  // gh api --paginate returns concatenated JSON arrays ([...][...]) which JSON.parse can't handle,
  // and --jq ".[]" breaks on multiline comment bodies. So we extract fields into flat objects.
  const jqExpr = `.[] | {path, line, start_line, side, body, login: .user.login}`;
  const output = await runGh(pi, cwd, [
    "api", `repos/${repo}/pulls/${prNumber}/comments`,
    "--paginate",
    "--jq", jqExpr,
  ]);
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
