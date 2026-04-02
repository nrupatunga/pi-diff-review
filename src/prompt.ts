import type { DiffReviewComment, DiffReviewFile, ReviewSubmitPayload } from "./types.js";

function formatLocation(comment: DiffReviewComment, filePath: string): string {
  if (comment.side === "file" || comment.startLine == null) {
    return filePath;
  }
  const suffix = comment.side === "original" ? " (old)" : " (new)";
  if (comment.endLine != null && comment.endLine !== comment.startLine) {
    return `${filePath}:${comment.startLine}-${comment.endLine}${suffix}`;
  }
  return `${filePath}:${comment.startLine}${suffix}`;
}

export function composeReviewPrompt(files: DiffReviewFile[], payload: ReviewSubmitPayload): string {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const lines: string[] = [];

  lines.push("Please address the following feedback");
  lines.push("");

  const overallComment = payload.overallComment.trim();
  if (overallComment.length > 0) {
    lines.push(overallComment);
    lines.push("");
  }

  payload.comments.forEach((comment, index) => {
    const file = fileMap.get(comment.fileId);
    const filePath = file?.displayPath ?? comment.fileId;
    lines.push(`${index + 1}. ${formatLocation(comment, filePath)}`);
    const body = comment.body.trim();
    if (comment.author) {
      lines.push(`   [${comment.author}]: ${body}`);
    } else {
      lines.push(`   ${body}`);
    }
    lines.push("");
  });

  return lines.join("\n").trim();
}

export function composePRCommentsPrompt(prNumber: string, files: DiffReviewFile[], comments: DiffReviewComment[]): string {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const lines: string[] = [];

  lines.push(`Please address the following PR #${prNumber} feedback`);
  lines.push("");

  comments.forEach((comment, index) => {
    const file = fileMap.get(comment.fileId);
    const filePath = file?.displayPath ?? comment.fileId;
    lines.push(`${index + 1}. ${formatLocation(comment, filePath)}`);
    if (comment.author) {
      lines.push(`   [${comment.author}]: ${comment.body.trim()}`);
    } else {
      lines.push(`   ${comment.body.trim()}`);
    }
    lines.push("");
  });

  if (comments.length === 0) {
    lines.push("No review comments found on this PR.");
  }

  return lines.join("\n").trim();
}
