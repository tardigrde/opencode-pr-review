import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { main } from "../scripts/main.mjs";

const dirs = [];
const savedEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  while (dirs.length > 0)
    fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function fakeOpencode() {
  const dir = tempDir("opencode-pr-review-fake-");
  const file = path.join(dir, "opencode");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const finding = {path:"f.js",line:2,severity:"high",title:"Bug",problem:"It fails.",fix:"Fix it."};
  const text = JSON.stringify({findings:[finding]});
  process.stdout.write(JSON.stringify({type:"text",part:{text}})+"\\n");
  process.stdout.write(JSON.stringify({type:"step_finish",part:{reason:"stop"}})+"\\n");
});
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function makeRepo() {
  const dir = tempDir("opencode-pr-review-action-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "f.js"), "const a = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]).trim();
  fs.writeFileSync(path.join(dir, "f.js"), "const a = 1;\nbug();\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "head"]);
  const headSha = git(dir, ["rev-parse", "HEAD"]).trim();
  return { dir, baseSha, headSha };
}

test("action smoke test posts one inline finding", async () => {
  const { dir, baseSha, headSha } = makeRepo();
  const eventPath = path.join(
    tempDir("opencode-pr-review-event-"),
    "event.json",
  );
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 1,
        draft: false,
        user: { type: "User" },
        head: { sha: headSha, repo: { full_name: "owner/repo" } },
        base: { sha: baseSha },
      },
    }),
  );

  const outputPath = path.join(tempDir("opencode-pr-review-output-"), "output");
  fs.writeFileSync(outputPath, "");

  let posted;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/user") {
      response.end(
        JSON.stringify({ login: "github-actions[bot]", type: "Bot" }),
      );
      return;
    }
    if (
      url.pathname === "/repos/owner/repo/pulls/1" &&
      request.method === "GET"
    ) {
      response.end(JSON.stringify({ head: { sha: headSha } }));
      return;
    }
    if (url.pathname === "/repos/owner/repo/pulls/1/files") {
      response.end(
        JSON.stringify([{ filename: "f.js", patch: "@@ -1,0 +2 @@\n+bug();" }]),
      );
      return;
    }
    if (
      url.pathname === "/repos/owner/repo/pulls/1/reviews" &&
      request.method === "GET"
    ) {
      response.end(JSON.stringify([]));
      return;
    }
    if (
      url.pathname === "/repos/owner/repo/pulls/1/reviews" &&
      request.method === "POST"
    ) {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        posted = JSON.parse(body);
        response.end(JSON.stringify({ id: 42 }));
      });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${address.port}`;

  Object.assign(process.env, {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: dir,
    GITHUB_API_URL: apiUrl,
    GITHUB_OUTPUT: outputPath,
    INPUT_OPENCODE_API_KEY: "oc_test_key",
    INPUT_GITHUB_TOKEN: "gh_test_token",
    INPUT_OPENCODE_VERSION: "2.3.2",
    INPUT_DRY_RUN: "false",
    OPENCODE_BIN: fakeOpencode(),
  });

  try {
    const code = await main();
    assert.equal(code, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.ok(posted);
  assert.equal(posted.event, "COMMENT");
  assert.equal(posted.commit_id, headSha);
  assert.equal(posted.comments.length, 1);
  assert.equal(posted.comments[0].path, "f.js");
  assert.equal(posted.comments[0].line, 2);
  assert.equal(posted.comments[0].side, "RIGHT");
  assert.match(posted.body, /1 high\. See inline comments\./);
  assert.match(posted.body, /opencode-pr-review:v2/);

  const output = fs.readFileSync(outputPath, "utf8");
  assert.match(output, /findings=1/);
  assert.match(output, /review_id=42/);
  assert.match(output, /posted=true/);
});
