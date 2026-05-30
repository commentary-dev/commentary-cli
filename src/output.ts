import type {
  BrainstormingConsensusStateResult,
  DraftReviewAccessGrant,
  DraftReviewGitBaseMetadata,
  DraftReviewLiveEvent,
  DraftReviewRevision,
  DraftReviewShareLink,
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

function formatMode(mode: string | null | undefined) {
  return mode ?? "draft";
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
    `Mode: ${formatMode(input.draftReview.mode)}`,
    `Files: ${input.fileCount}`,
    `Session: ${input.draftReview.id}`,
    `URL: ${input.draftReview.reviewUrl}`,
    `Git base: ${formatGitBase(input.draftReview.gitBase)}`,
    "",
    `Saved local session metadata to ${input.sessionFilePath}`,
  ].join("\n");
}

export function formatReviewRestored(input: {
  metadata: SessionMetadata;
  sessionFilePath: string;
  changedFiles: string[];
  synced: boolean;
  dryRun?: boolean | undefined;
  noSync?: boolean | undefined;
  revision?: DraftReviewRevision | undefined;
}) {
  const status = input.dryRun
    ? input.noSync
      ? "Would restore local session metadata without syncing"
      : input.changedFiles.length > 0
        ? "Would restore local session metadata and sync changes"
        : "Would restore local session metadata; no sync needed"
    : "Restored Commentary review";
  const lines = [
    status,
    "",
    `Session: ${input.metadata.reviewSessionId}`,
    `Files: ${input.metadata.trackedFiles.length}`,
    `Changed files: ${input.changedFiles.length ? input.changedFiles.join(", ") : "none"}`,
    input.revision ? `Revision: ${input.revision.revisionNumber}` : null,
    input.noSync && input.changedFiles.length > 0 ? "Sync: skipped by --no-sync" : null,
    `URL: ${input.metadata.reviewUrl}`,
    "",
    input.dryRun
      ? `Would save local session metadata to ${input.sessionFilePath}`
      : `Saved local session metadata to ${input.sessionFilePath}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatGitBase(gitBase: DraftReviewGitBaseMetadata | null | undefined) {
  if (!gitBase) {
    return "none";
  }
  return [
    `${gitBase.owner}/${gitBase.repo}`,
    gitBase.ref ? `ref ${gitBase.ref}` : null,
    gitBase.sha ? `sha ${gitBase.sha}` : null,
    gitBase.path ? `path ${gitBase.path}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatDraftRebased(input: { draftReview: DraftReviewSession }) {
  return [
    "Updated Commentary review base",
    "",
    `Session: ${input.draftReview.id}`,
    `URL: ${input.draftReview.reviewUrl}`,
    `Git base: ${formatGitBase(input.draftReview.gitBase)}`,
  ].join("\n");
}

function shareLinkUrl(link: DraftReviewShareLink) {
  return link.url ?? link.shareUrl ?? null;
}

function accessGrantRecipient(grant: DraftReviewAccessGrant) {
  return grant.recipient ?? grant.email ?? grant.userId ?? "unknown";
}

export function formatDraftReviewShares(input: {
  sessionId: string;
  shareLinks?: DraftReviewShareLink[] | undefined;
  accessGrants?: DraftReviewAccessGrant[] | undefined;
}) {
  const shareLinks = input.shareLinks ?? [];
  const accessGrants = input.accessGrants ?? [];
  const lines = [`Draft review shares`, "", `Session: ${input.sessionId}`];

  lines.push("", "Share links:");
  if (shareLinks.length === 0) {
    lines.push("none");
  } else {
    for (const link of shareLinks) {
      lines.push(
        [link.id, link.audience ?? "anyone", shareLinkUrl(link) ?? ""].filter(Boolean).join("\t"),
      );
    }
  }

  lines.push("", "User access:");
  if (accessGrants.length === 0) {
    lines.push("none");
  } else {
    for (const grant of accessGrants) {
      lines.push([grant.id, accessGrantRecipient(grant)].join("\t"));
    }
  }

  return lines.join("\n");
}

export function formatDraftReviewShared(input: {
  sessionId: string;
  shareLink?: DraftReviewShareLink | undefined;
  accessGrant?: DraftReviewAccessGrant | undefined;
}) {
  if (input.shareLink) {
    const url = shareLinkUrl(input.shareLink);
    return [
      "Shared Commentary review",
      "",
      `Session: ${input.sessionId}`,
      `Share link: ${input.shareLink.id}`,
      url ? `URL: ${url}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (input.accessGrant) {
    return [
      "Shared Commentary review",
      "",
      `Session: ${input.sessionId}`,
      `Access grant: ${input.accessGrant.id}`,
      `Recipient: ${accessGrantRecipient(input.accessGrant)}`,
    ].join("\n");
  }
  return [`Shared Commentary review`, "", `Session: ${input.sessionId}`].join("\n");
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

function formatConsensus(thread: DraftThread) {
  if (!thread.consensus?.state) {
    return null;
  }
  const reason = thread.consensus.reason ? ` - ${thread.consensus.reason}` : "";
  return `Consensus: ${thread.consensus.state}${reason}`;
}

function formatFeedbackSummary(thread: DraftThread) {
  if (!thread.feedbackSummary) {
    return null;
  }
  const parts = Object.entries(thread.feedbackSummary)
    .filter(([, value]) => typeof value === "number" && value > 0)
    .map(([key, value]) => `${key}: ${value}`);
  return parts.length ? `Feedback: ${parts.join(", ")}` : null;
}

export function formatBrainstormingConsensusState(input: {
  sessionId: string;
  state: BrainstormingConsensusStateResult;
}) {
  const counts = input.state.counts;
  return [
    "Brainstorming review status",
    "",
    `Session: ${input.sessionId}`,
    `Agent ready: ${input.state.agentReady ? "yes" : "no"}`,
    `Accepted for change: ${counts.acceptedForChange ?? 0}`,
    `Blocked: ${counts.blocked ?? 0}`,
    `Needs owner decision: ${counts.needsOwnerDecision ?? 0}`,
    `Pending: ${counts.pending ?? 0}`,
    `Applied: ${counts.applied ?? 0}`,
    `Resolved: ${counts.resolved ?? 0}`,
    `Actionable files: ${
      input.state.filesWithActionableThreads.length
        ? input.state.filesWithActionableThreads.join(", ")
        : "none"
    }`,
    `Blocked files: ${
      input.state.filesWithBlockedThreads.length
        ? input.state.filesWithBlockedThreads.join(", ")
        : "none"
    }`,
  ].join("\n");
}

function commentBody(thread: DraftThread) {
  const first = thread.comments[0];
  return first?.bodyMarkdown ?? first?.body ?? "";
}

function commentAuthor(thread: DraftThread) {
  const first = thread.comments[0];
  return first?.agentAlias ?? first?.authorLogin ?? first?.author ?? "Unknown";
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
        formatConsensus(thread),
        formatFeedbackSummary(thread),
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
    const consensus = formatConsensus(thread);
    if (consensus) {
      lines.push(consensus);
    }
    const feedback = formatFeedbackSummary(thread);
    if (feedback) {
      lines.push(feedback);
    }
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
          `- ${reply.agentAlias ?? reply.authorLogin ?? reply.author ?? "Unknown"}: ${reply.bodyMarkdown ?? reply.body ?? ""}`,
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
