import type {
  DraftReviewLiveEvent,
  DraftReviewRevision,
  DraftReviewSession,
  DraftThread,
  JsonObject,
  SessionMetadata,
} from "./types.js";

export type Writer = {
  write(chunk: string): void;
};

export function writeJson(stdout: Writer, value: unknown) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(stdout: Writer, value: string) {
  stdout.write(`${value.trimEnd()}\n`);
}

export function formatReviewCreated(input: {
  draftReview: DraftReviewSession;
  sessionFilePath: string;
  fileCount: number;
}) {
  return [
    "Created Commentary review",
    "",
    `Title: ${input.draftReview.title}`,
    `Files: ${input.fileCount}`,
    `Session: ${input.draftReview.id}`,
    `URL: ${input.draftReview.reviewUrl}`,
    "",
    `Saved local session metadata to ${input.sessionFilePath}`,
  ].join("\n");
}

export function formatRevision(input: {
  metadata: SessionMetadata;
  revision: DraftReviewRevision;
  uploaded: number;
  noOp?: boolean | undefined;
}) {
  return [
    input.noOp ? "No changes to sync" : "Synced Commentary review",
    "",
    `Session: ${input.metadata.reviewSessionId}`,
    `Revision: ${input.revision.revisionNumber}`,
    `Files uploaded: ${input.uploaded}`,
    `URL: ${input.metadata.reviewUrl}`,
  ].join("\n");
}

function commentBody(thread: DraftThread) {
  const first = thread.comments[0];
  return first?.bodyMarkdown ?? first?.body ?? "";
}

function commentAuthor(thread: DraftThread) {
  const first = thread.comments[0];
  return first?.authorLogin ?? first?.author ?? "Unknown";
}

export function formatCommentsText(threads: DraftThread[]) {
  if (threads.length === 0) {
    return "No comments found.";
  }
  return threads
    .map((thread) =>
      [
        `[${thread.id}] ${thread.filePath}`,
        `Status: ${thread.status}`,
        thread.selectedText ? `Anchor: "${thread.selectedText}"` : null,
        `${commentAuthor(thread)}: ${commentBody(thread)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

export function formatCommentsMarkdown(input: {
  session: SessionMetadata;
  threads: DraftThread[];
}) {
  const lines = [
    "# Commentary Review Comments",
    "",
    `Session: ${input.session.reviewSessionId}`,
    `URL: ${input.session.reviewUrl}`,
    "",
  ];
  if (input.threads.length === 0) {
    lines.push("No comments found.");
    return lines.join("\n");
  }
  for (const thread of input.threads) {
    lines.push(`## Comment ${thread.id}`, "");
    lines.push(`File: ${thread.filePath}`);
    lines.push(`Status: ${thread.status}`);
    if (thread.selectedText) {
      lines.push(`Anchor: "${thread.selectedText}"`);
    }
    if (thread.sourceLineStart) {
      lines.push(
        `Lines: ${thread.sourceLineStart}${thread.sourceLineEnd && thread.sourceLineEnd !== thread.sourceLineStart ? `-${thread.sourceLineEnd}` : ""}`,
      );
    }
    lines.push("", "User comment:", `> ${commentBody(thread).replace(/\n/g, "\n> ")}`, "");
    const replies = thread.comments.slice(1);
    if (replies.length > 0) {
      lines.push("Replies:");
      replies.forEach((reply) => {
        lines.push(
          `- ${reply.authorLogin ?? reply.author ?? "Unknown"}: ${reply.bodyMarkdown ?? reply.body ?? ""}`,
        );
      });
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

export function formatWaitCommentText(event: DraftReviewLiveEvent) {
  if (!event.thread) {
    return `Received ${event.type} (${event.id}).`;
  }
  const thread = event.thread;
  const body = commentBody(thread);
  return [
    `[${thread.id}] ${thread.filePath}`,
    `Event: ${event.type}`,
    `Status: ${thread.status}`,
    thread.selectedText ? `Anchor: "${thread.selectedText}"` : null,
    `${commentAuthor(thread)}: ${body}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatWaitCommentMarkdown(input: {
  session: SessionMetadata;
  event: DraftReviewLiveEvent;
}) {
  const lines = [
    "# Commentary Comment",
    "",
    `Session: ${input.session.reviewSessionId}`,
    `URL: ${input.session.reviewUrl}`,
    `Event: ${input.event.type}`,
    `Cursor: ${input.event.id}`,
    "",
  ];
  if (!input.event.thread) {
    lines.push("No thread payload was available for this event.");
    return lines.join("\n");
  }
  lines.push(formatCommentsMarkdown({ session: input.session, threads: [input.event.thread] }));
  return lines.join("\n").trimEnd();
}

export function publicSessionJson(metadata: SessionMetadata): JsonObject {
  return {
    reviewSessionId: metadata.reviewSessionId,
    reviewUrl: metadata.reviewUrl,
    baseUrl: metadata.baseUrl,
    rootPath: metadata.rootPath,
    trackedFiles: metadata.trackedFiles,
    createdAt: metadata.createdAt,
    lastSyncedAt: metadata.lastSyncedAt,
    lastKnownRevision: metadata.lastKnownRevision,
  };
}
