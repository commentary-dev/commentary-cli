import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import type { DraftReviewLiveEvent, DraftThread } from "../src/types.js";

const baseUrl = process.env.COMMENTARY_LIVE_BASE_URL ?? "https://commentary.dev";
const token = process.env.COMMENTARY_LIVE_TOKEN;

if (!token) {
  console.error("COMMENTARY_LIVE_TOKEN is required for live tests.");
  process.exit(1);
}

type ReviewCreatedJson = {
  session: {
    reviewSessionId: string;
  };
};

type WaitCommentJson = {
  ok: true;
  event: DraftReviewLiveEvent;
};

type CommentsJson = {
  ok: true;
  threads: DraftThread[];
};

const stderr = {
  write(chunk: string) {
    process.stderr.write(chunk);
  },
};

async function runCliJson<T>(args: string[], cwd: string) {
  let output = "";
  const code = await runCli(args, {
    cwd,
    stdout: {
      write(chunk: string) {
        output += chunk;
      },
    },
    stderr,
    isTty: false,
  });
  if (code !== 0) {
    throw new Error(`commentary ${args.join(" ")} failed with exit code ${code}.`);
  }
  return JSON.parse(output) as T;
}

async function runCliOk(args: string[], cwd: string) {
  const code = await runCli(args, {
    cwd,
    stdout: { write() {} },
    stderr,
    isTty: false,
  });
  if (code !== 0) {
    throw new Error(`commentary ${args.join(" ")} failed with exit code ${code}.`);
  }
}

async function postReviewerComment(input: {
  sessionId: string;
  filePath: string;
  bodyMarkdown: string;
}) {
  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}/comments`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filePath: input.filePath,
        blockId: "paragraph-2",
        nodeType: "paragraph",
        sourceLineStart: 3,
        sourceLineEnd: 3,
        selectedText: "Current reviewer target.",
        bodyMarkdown: input.bodyMarkdown,
        agentAlias: "live-e2e-reviewer",
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Reviewer comment failed with ${response.status}: ${await response.text()}`);
  }
}

function assertWaitedForComment(input: {
  turn: number;
  payload: WaitCommentJson;
  expectedBody: string;
}) {
  const firstComment = input.payload.event.thread?.comments[0];
  if (input.payload.event.type !== "comment.created") {
    throw new Error(
      `Turn ${input.turn} received ${input.payload.event.type}, not comment.created.`,
    );
  }
  if (firstComment?.bodyMarkdown !== input.expectedBody) {
    throw new Error(`Turn ${input.turn} received the wrong comment body.`);
  }
}

const dir = await mkdtemp(path.join(os.tmpdir(), "commentary-live-"));
try {
  const file = path.join(dir, "live-smoke.md");
  const relativeFile = "live-smoke.md";
  await writeFile(file, "# CLI live smoke\n\nCurrent reviewer target.\n", "utf8");

  const created = await runCliJson<ReviewCreatedJson>(
    [
      "review",
      relativeFile,
      "--title",
      `CLI live smoke ${new Date().toISOString()}`,
      "--no-open",
      "--base-url",
      baseUrl,
      "--token",
      token,
      "--json",
    ],
    dir,
  );

  const sessionId = created.session.reviewSessionId;
  const firstComment = "Live E2E turn 1 reviewer comment.";
  const firstWait = runCliJson<WaitCommentJson>(
    [
      "wait-comment",
      "--session",
      sessionId,
      "--from",
      "beginning",
      "--file",
      relativeFile,
      "--timeout",
      "45s",
      "--base-url",
      baseUrl,
      "--token",
      token,
      "--json",
    ],
    dir,
  );
  await postReviewerComment({ sessionId, filePath: relativeFile, bodyMarkdown: firstComment });
  const firstWaitPayload = await firstWait;
  assertWaitedForComment({ turn: 1, payload: firstWaitPayload, expectedBody: firstComment });

  await writeFile(
    file,
    "# CLI live smoke\n\nCurrent reviewer target.\n\nTurn 1 addressed.\n",
    "utf8",
  );
  await runCliOk(
    ["sync", "--message", "Address live E2E turn 1", "--base-url", baseUrl, "--token", token],
    dir,
  );

  const secondComment = "Live E2E turn 2 reviewer comment.";
  const secondWait = runCliJson<WaitCommentJson>(
    [
      "wait-comment",
      "--session",
      sessionId,
      "--cursor",
      firstWaitPayload.event.id,
      "--file",
      relativeFile,
      "--timeout",
      "45s",
      "--base-url",
      baseUrl,
      "--token",
      token,
      "--json",
    ],
    dir,
  );
  await postReviewerComment({ sessionId, filePath: relativeFile, bodyMarkdown: secondComment });
  const secondWaitPayload = await secondWait;
  assertWaitedForComment({ turn: 2, payload: secondWaitPayload, expectedBody: secondComment });

  await writeFile(
    file,
    "# CLI live smoke\n\nCurrent reviewer target.\n\nTurn 1 addressed.\n\nTurn 2 addressed.\n",
    "utf8",
  );
  await runCliOk(
    ["sync", "--message", "Address live E2E turn 2", "--base-url", baseUrl, "--token", token],
    dir,
  );

  const comments = await runCliJson<CommentsJson>(
    [
      "comments",
      "--all",
      "--session",
      sessionId,
      "--base-url",
      baseUrl,
      "--token",
      token,
      "--json",
    ],
    dir,
  );
  const bodies = comments.threads.flatMap((thread) =>
    thread.comments.map((comment) => comment.bodyMarkdown ?? comment.body ?? ""),
  );
  if (!bodies.includes(firstComment) || !bodies.includes(secondComment)) {
    throw new Error("Live E2E comments were not both visible after the two-turn loop.");
  }
  const finalContent = await readFile(file, "utf8");
  if (!finalContent.includes("Turn 1 addressed.") || !finalContent.includes("Turn 2 addressed.")) {
    throw new Error("Live E2E local edits did not include both addressed turns.");
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
