export type DraftContentType = "markdown" | "html" | "plain_text";
export type RequestedContentType = DraftContentType | "auto";

export type DraftFileInput = {
  path: string;
  content: string;
  contentType: DraftContentType;
  fileId?: string | undefined;
};

export type DraftReviewFile = {
  id: string;
  path: string;
  displayName?: string | null;
  contentType: DraftContentType;
  currentRevisionId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type DraftReviewFileRevision = {
  fileRevisionId: string;
  fileId: string;
  path: string;
  contentType: DraftContentType;
  contentHash: string;
  sizeBytes: number;
  createdAt?: string;
};

export type DraftReviewRevision = {
  id: string;
  revisionNumber: number;
  label?: string | null;
  origin?: string;
  summary?: string | null;
  createdAt?: string;
  files: DraftReviewFileRevision[];
};

export type DraftReviewSession = {
  id: string;
  title: string;
  description?: string | null;
  sourceType?: string;
  status?: string;
  visibility?: string;
  reviewUrl: string;
  createdAt?: string;
  updatedAt?: string;
  files: DraftReviewFile[];
  latestRevision: DraftReviewRevision | null;
};

export type DraftThreadComment = {
  id?: string | number;
  author?: string | null;
  authorLogin?: string | null;
  agentAlias?: string | null;
  bodyMarkdown?: string | null;
  body?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type DraftThread = {
  id: string;
  fileId: string | null;
  filePath: string;
  status: "open" | "resolved";
  anchorStatus?: string | null;
  blockId?: string | null;
  nodeType?: string | null;
  sourceLineStart?: number | null;
  sourceLineEnd?: number | null;
  selectedText?: string | null;
  prefixText?: string | null;
  suffixText?: string | null;
  comments: DraftThreadComment[];
  latestRevision?: {
    id: string;
    revisionNumber: number;
    fileRevisionId: string | null;
  } | null;
  createdAt?: string;
  updatedAt?: string;
};

export type DraftReviewLiveEventType =
  | "comment.created"
  | "reply.created"
  | "comment.edited"
  | "thread.status_changed"
  | "draft.status_changed"
  | "revision.created"
  | "draft.rebased"
  | "draft.deleted";

export type DraftReviewLiveEvent = {
  id: string;
  type: DraftReviewLiveEventType;
  createdAt: string;
  payload: Record<string, unknown>;
  thread: DraftThread | null;
};

export type TrackedFile = {
  path: string;
  fileId?: string | undefined;
  contentType: DraftContentType;
  contentHash: string;
  sizeBytes: number;
};

export type SessionMetadata = {
  version: 1;
  reviewSessionId: string;
  reviewUrl: string;
  baseUrl: string;
  rootPath: string;
  trackedFiles: TrackedFile[];
  source: string[];
  createdAt: string;
  lastSyncedAt: string;
  lastKnownRevision: number | null;
};

export type JsonObject = Record<string, unknown>;
