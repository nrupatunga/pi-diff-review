export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface DiffReviewFile {
  id: string;
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
}

export interface DiffReviewFileContents {
  oldContent: string;
  newContent: string;
}

export type CommentSide = "original" | "modified" | "file";

export interface DiffReviewComment {
  id: string;
  fileId: string;
  side: CommentSide;
  startLine: number | null;
  endLine: number | null;
  body: string;
}

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  comments: DiffReviewComment[];
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export interface ReviewRequestFilePayload {
  type: "request-file";
  requestId: string;
  fileId: string;
}

export type ReviewWindowMessage = ReviewSubmitPayload | ReviewCancelPayload | ReviewRequestFilePayload;

export interface ReviewFileDataMessage {
  type: "file-data";
  requestId: string;
  fileId: string;
  oldContent: string;
  newContent: string;
}

export interface ReviewFileErrorMessage {
  type: "file-error";
  requestId: string;
  fileId: string;
  message: string;
}

export type ReviewHostMessage = ReviewFileDataMessage | ReviewFileErrorMessage;

export interface DiffReviewWindowData {
  repoRoot: string;
  files: DiffReviewFile[];
}
