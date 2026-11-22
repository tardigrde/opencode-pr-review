import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  collectDiff,
  parseDiff,
  parsePatch,
  unquoteGitPath,
} from "../scripts/collect-diff.mjs";

const dirs = [];

afterEach(() => {
  while (dirs.length > 0)
    fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function repo(files) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "opencode-pr-review-diff-"),
  );
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
}

async function diffFor(dir) {
  const baseSha = git(dir, ["rev-parse", "HEAD~1"]).trim();
  const headSha = git(dir, ["rev-parse", "HEAD"]).trim();
  return collectDiff({ workspace: dir, baseSha, headSha, maxBytes: 1_000_000 });
}

describe("collectDiff", () => {
  test("finds a simple added line", async () => {
    const dir = repo({ "f.txt": "a\n" });
    fs.writeFileSync(path.join(dir, "f.txt"), "a\nb\n");
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.deepEqual([...result.map.get("f.txt")], [2]);
  });

  test("handles hunk headers with function context", async () => {
    const dir = repo({ "plain.txt": "one\n" });
    fs.writeFileSync(path.join(dir, "plain.txt"), "one\nTWO\n");
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.deepEqual([...result.map.get("plain.txt")], [2]);
  });

  test("keeps added content that starts with ++", async () => {
    const dir = repo({ "plus.c": "int counter = 0;\n" });
    fs.writeFileSync(
      path.join(dir, "plus.c"),
      "int counter = 0;\n++counter;\n",
    );
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.deepEqual([...result.map.get("plus.c")], [2]);
  });

  test("does not treat header-lookalike content as a file header", async () => {
    const dir = repo({ "f.txt": "base\n" });
    fs.writeFileSync(path.join(dir, "f.txt"), "base\n++ b/evil.txt\n");
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.deepEqual([...result.map.get("f.txt")], [2]);
    assert.equal(result.map.has("evil.txt"), false);
  });

  test("counts the new line after deletions, not the hunk index", async () => {
    const dir = repo({ "f.txt": "a\nb\nc\n" });
    fs.writeFileSync(path.join(dir, "f.txt"), "a\nX\n");
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.deepEqual([...result.map.get("f.txt")], [2]);
  });

  test("decodes a quoted Unicode path", async () => {
    const dir = repo({ "café.txt": "a\n" });
    fs.writeFileSync(path.join(dir, "café.txt"), "a\nb\n");
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.deepEqual([...result.map.get("café.txt")], [2]);
  });

  test("strips the trailing tab from a path with spaces", async () => {
    const dir = repo({ "space name.txt": "a\n" });
    fs.writeFileSync(path.join(dir, "space name.txt"), "a\nb\n");
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.deepEqual([...result.map.get("space name.txt")], [2]);
  });

  test("keeps the line count with CRLF", async () => {
    const dir = repo({ "f.txt": "a\n" });
    fs.writeFileSync(path.join(dir, "f.txt"), "a\r\nb\r\n");
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.ok(result.map.get("f.txt").has(2));
  });

  test("does not advance on a no-newline marker", () => {
    const result = parseDiff(
      [
        "diff --git a/f.txt b/f.txt",
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    assert.deepEqual([...result.map.get("f.txt")], [1]);
  });

  test("handles a no-newline change in a real diff", async () => {
    const dir = repo({ "f.txt": "a\nb" });
    fs.writeFileSync(path.join(dir, "f.txt"), "a\nb\nc");
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.deepEqual([...result.map.get("f.txt")], [2, 3]);
  });

  test("uses the new path for a rename with an edit", async () => {
    const dir = repo({ "old.txt": "a\n" });
    fs.renameSync(path.join(dir, "old.txt"), path.join(dir, "new.txt"));
    fs.appendFileSync(path.join(dir, "new.txt"), "b\n");
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.deepEqual([...result.map.get("new.txt")], [2]);
  });

  test("handles a pure rename with no hunks", async () => {
    const dir = repo({ "old.txt": "a\nb\n" });
    fs.renameSync(path.join(dir, "old.txt"), path.join(dir, "new.txt"));
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.equal(result.map.size, 0);
  });

  test("records a binary change without anchors", async () => {
    const dir = repo({ "b.bin": Buffer.from([0, 1, 2]) });
    fs.writeFileSync(path.join(dir, "b.bin"), Buffer.from([0, 3, 4]));
    commitAll(dir, "head");
    const result = await diffFor(dir);
    assert.equal(result.map.size, 0);
    assert.ok(result.binaryFiles.has("b.bin"));
  });

  test("can recover a text diff hidden by .gitattributes -diff", async () => {
    const dir = repo({ "f.js": "a\n", ".gitattributes": "*.js -diff\n" });
    fs.writeFileSync(path.join(dir, "f.js"), "a\nEVIL\n");
    commitAll(dir, "head");
    const baseSha = git(dir, ["rev-parse", "HEAD~1"]).trim();
    const headSha = git(dir, ["rev-parse", "HEAD"]).trim();
    const normal = await collectDiff({
      workspace: dir,
      baseSha,
      headSha,
      maxBytes: 1_000_000,
    });
    assert.equal(normal.map.size, 0);
    const forced = await collectDiff({
      workspace: dir,
      baseSha,
      headSha,
      maxBytes: 1_000_000,
      text: true,
      paths: ["f.js"],
    });
    assert.deepEqual([...forced.map.get("f.js")], [2]);
  });
});

describe("parseDiff and parsePatch", () => {
  test("parses a synthetic hunk with a function header", () => {
    const result = parseDiff(
      [
        "diff --git a/f.c b/f.c",
        "--- a/f.c",
        "+++ b/f.c",
        "@@ -2 +2 @@ function foo() {",
        "-old",
        "+new",
      ].join("\n"),
    );
    assert.deepEqual([...result.map.get("f.c")], [2]);
  });

  test("parses a GitHub patch without file headers", () => {
    const lines = parsePatch("@@ -1,2 +1,3 @@\n a\n-b\n+X\n+Y", "f.txt");
    assert.deepEqual([...lines], [2, 3]);
  });

  test("unquotes Git C-style paths", () => {
    assert.equal(unquoteGitPath('"b/caf\\303\\251.txt"'), "café.txt");
    assert.equal(unquoteGitPath('"b/back\\\\slash.txt"'), "back\\slash.txt");
    assert.equal(unquoteGitPath("/dev/null"), null);
  });
});
