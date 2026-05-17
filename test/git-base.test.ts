import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGitHubRemoteUrl, resolveGitBase, validateGitBaseFilePath } from "../src/git-base.js";

describe("git base helpers", () => {
  it("parses common GitHub remote URL formats", () => {
    expect(parseGitHubRemoteUrl("https://github.com/commentary-dev/commentary-cli.git")).toEqual({
      owner: "commentary-dev",
      repo: "commentary-cli",
    });
    expect(parseGitHubRemoteUrl("git@github.com:commentary-dev/commentary-cli.git")).toEqual({
      owner: "commentary-dev",
      repo: "commentary-cli",
    });
    expect(parseGitHubRemoteUrl("ssh://git@github.com/commentary-dev/commentary-cli.git")).toEqual({
      owner: "commentary-dev",
      repo: "commentary-cli",
    });
  });

  it("builds explicit GitHub base metadata", async () => {
    const gitBase = await resolveGitBase({
      cwd: "/repo",
      root: "/repo",
      files: [{ path: "docs/spec.md" }],
      options: {
        gitBaseRepo: "commentary-dev/commentary-docs",
        gitBaseSha: "abc123",
        gitBaseRef: "main",
      },
    });

    expect(gitBase).toEqual({
      provider: "github",
      owner: "commentary-dev",
      repo: "commentary-docs",
      ref: "main",
      sha: "abc123",
      path: "docs/spec.md",
    });
  });

  it("builds automatic GitHub base metadata from git commands", async () => {
    const root = path.resolve("repo");
    const gitBase = await resolveGitBase({
      cwd: root,
      root,
      files: [{ path: "docs/spec.md", absolutePath: path.join(root, "docs/spec.md") }],
      options: { gitBase: "auto", gitRemote: "upstream" },
      runner: async (args) => {
        const command = args.join(" ");
        if (command === "rev-parse --show-toplevel") {
          return root;
        }
        if (command === "remote get-url upstream") {
          return "git@github.com:commentary-dev/commentary-docs.git";
        }
        if (command === "rev-parse HEAD") {
          return "abc123";
        }
        if (command === "branch --show-current") {
          return "main";
        }
        throw new Error(command);
      },
    });

    expect(gitBase).toEqual({
      provider: "github",
      owner: "commentary-dev",
      repo: "commentary-docs",
      ref: "main",
      sha: "abc123",
      path: "docs/spec.md",
    });
  });

  it("requires the GitHub base file path to match the review path", () => {
    expect(() => validateGitBaseFilePath([{ path: "spec.md" }], "docs/spec.md")).toThrow(
      "GitHub base path must match",
    );
  });
});
