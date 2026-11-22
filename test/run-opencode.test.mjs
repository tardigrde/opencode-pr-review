import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  buildChildEnv,
  parseOpencodeEvents,
  runOpencode,
} from "../scripts/run-opencode.mjs";

const dirs = [];

afterEach(() => {
  while (dirs.length > 0)
    fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function fakeBin(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pr-review-bin-"));
  dirs.push(dir);
  const file = path.join(dir, "fake-opencode");
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function options(bin) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "opencode-pr-review-run-"),
  );
  dirs.push(root);
  return {
    bin,
    model: "m/x",
    prompt: "prompt",
    configContent: "{}",
    apiKey: "oc_test",
    runDir: root,
    home: root,
    config: root,
    data: root,
    cache: root,
    configDir: root,
    timeoutSeconds: 5,
  };
}

describe("parseOpencodeEvents", () => {
  test("joins text deltas and ignores noise", () => {
    const text = parseOpencodeEvents(
      [
        "not json",
        '{"type":"text","part":{"text":"{\\"findings\\":"}}',
        '{"type":"text","part":{"text":"[]}"}}',
        '{"type":"step_finish","part":{"reason":"stop"}}',
      ].join("\n"),
    );
    assert.equal(text, '{"findings":[]}');
  });

  test("fails on an error event", () => {
    assert.throws(
      () =>
        parseOpencodeEvents(
          '{"type":"error","error":{"message":"overloaded"}}',
        ),
      /overloaded/,
    );
  });

  test("fails on a truncated finish reason", () => {
    assert.throws(
      () =>
        parseOpencodeEvents(
          '{"type":"text","part":{"text":"x"}}\n{"type":"step_finish","part":{"reason":"length"}}',
        ),
      /length/,
    );
  });
});

describe("child env", () => {
  test("contains only the allowlist", () => {
    const env = buildChildEnv({
      apiKey: "oc_test",
      configContent: "{}",
      home: "/tmp/home",
      config: "/tmp/config",
      data: "/tmp/data",
      cache: "/tmp/cache",
      configDir: "/tmp/config-dir",
    });
    assert.equal(env.OPENCODE_API_KEY, "oc_test");
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
    for (const key of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "ACTIONS_RUNTIME_TOKEN",
      "INPUT_X",
      "NPM_TOKEN",
    ]) {
      assert.equal(Object.hasOwn(env, key), false, key);
    }
  });
});

describe("runOpencode", () => {
  test("reads text from a fake binary", async () => {
    const bin = fakeBin(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({type:"text",part:{text:"{\\"findings\\":[]}"}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"step_finish",part:{reason:"stop"}}) + "\\n");
});
`);
    const text = await runOpencode(options(bin));
    assert.equal(text, '{"findings":[]}');
  });

  test("fails on a non-zero exit", async () => {
    const bin = fakeBin(`process.stderr.write("broken"); process.exit(2);`);
    await assert.rejects(() => runOpencode(options(bin)), /code 2/);
  });
});
