import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFiles } from "../src/files.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "commentary-files-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("file collection", () => {
  it("collects supported files from folders and ignores noisy directories", async () => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await mkdir(path.join(dir, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(dir, "docs/spec.md"), "# Spec\n", "utf8");
    await writeFile(path.join(dir, "docs/page.html"), "<main>Page</main>\n", "utf8");
    await writeFile(path.join(dir, "node_modules/pkg/readme.md"), "# Ignore\n", "utf8");

    const files = await collectFiles(["docs"], { root: dir });

    expect(files.map((file) => file.path)).toEqual(["docs/page.html", "docs/spec.md"]);
    expect(files.map((file) => file.contentType)).toEqual(["html", "markdown"]);
  });

  it("rejects unsupported direct files", async () => {
    await writeFile(path.join(dir, "image.png"), "not really png", "utf8");
    await expect(collectFiles(["image.png"], { root: dir })).rejects.toThrow(
      /Unsupported file type/,
    );
  });
});
