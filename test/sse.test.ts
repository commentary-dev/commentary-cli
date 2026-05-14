import { describe, expect, it } from "vitest";
import { SseParser } from "../src/sse.js";

describe("SseParser", () => {
  it("parses ids, event names, comments, retries, and multi-line data", () => {
    const parser = new SseParser();

    const messages = parser.feed(
      [
        ": connected",
        "retry: 2000",
        "id: event_1",
        "event: draft-review",
        'data: {"a":1,',
        'data: "b":2}',
        "",
        "",
      ].join("\n"),
    );

    expect(messages).toEqual([
      {
        id: "event_1",
        event: "draft-review",
        data: '{"a":1,\n"b":2}',
        retry: 2000,
      },
    ]);
  });

  it("retains the last id across messages", () => {
    const parser = new SseParser();

    expect(parser.feed("id: event_1\n\n")).toEqual([]);
    expect(parser.feed("event: draft-review\ndata: {}\n\n")).toEqual([
      {
        id: "event_1",
        event: "draft-review",
        data: "{}",
        retry: undefined,
      },
    ]);
  });
});
