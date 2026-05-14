import { describe, expect, it } from "vitest";
import { detectContentType, normalizeReviewPath } from "../src/content.js";

describe("content detection", () => {
  it("uses file extensions before HTML sniffing", () => {
    expect(detectContentType({ filePath: "docs/spec.md", content: "<main>Hello</main>" })).toBe(
      "markdown",
    );
    expect(detectContentType({ filePath: "site/index.html", content: "# Title" })).toBe("html");
    expect(detectContentType({ filePath: "notes.txt", content: "# Title" })).toBe("plain_text");
  });

  it("sniffs HTML when extension is unavailable", () => {
    expect(detectContentType({ filePath: "draft", content: "<article>Draft</article>" })).toBe(
      "html",
    );
    expect(detectContentType({ filePath: "draft", content: "# Draft" })).toBe("markdown");
  });

  it("normalizes and validates review paths", () => {
    expect(normalizeReviewPath("docs\\spec.md")).toBe("docs/spec.md");
    expect(() => normalizeReviewPath("../spec.md")).toThrow(/must not contain/);
    expect(() => normalizeReviewPath(["C:", "tmp", "spec.md"].join("/"))).toThrow(/relative/);
  });
});
