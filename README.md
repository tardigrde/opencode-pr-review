# OpenCode PR Review

[![test](https://github.com/tardigrde/opencode-pr-review/actions/workflows/test.yml/badge.svg)](https://github.com/tardigrde/opencode-pr-review/actions/workflows/test.yml)
[![license](https://img.shields.io/github/license/tardigrde/opencode-pr-review)](LICENSE)
[![release](https://img.shields.io/github/v/release/tardigrde/opencode-pr-review)](https://github.com/tardigrde/opencode-pr-review/releases)

Review a pull request with OpenCode Go and post one `COMMENT` review with inline
findings. The review is advisory. It does not approve, request changes, merge,
label, or assign.

## What it does

- Checks out the PR head and collects the diff against the base.
- Runs a read-only OpenCode review agent in a sanitized copy of the repository.
- Validates each finding against the local diff and GitHub's PR patch.
- Posts one GitHub review with a short summary and up to 20 inline comments.
- Skips fork PRs, drafts, bot PRs, and duplicate runs at the same head.

Each inline comment has a severity, a short title, the concrete problem, and a
short fix. The action does not post a walkthrough, file table, poem, or long
summary.

## Quick start

```yaml
name: OpenCode review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: opencode-pr-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: >
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.event.pull_request.draft == false &&
      github.event.pull_request.user.type != 'Bot'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38
        with:
          node-version: "24"
      - uses: tardigrde/opencode-pr-review@v1
        with:
          model: opencode-go/deepseek-v4.1-flash
          opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          max-findings: 20
          severity-threshold: medium
```

The built-in prompt works without extra files. Add `prompt` or `prompt-file`
only when you want custom focus. A missing `prompt-file` fails the job.

`@v1` is a convenience tag. Pin the action to a full release SHA for production
and supply-chain safety. Find the SHA on the release page:

```bash
git ls-remote https://github.com/tardigrde/opencode-pr-review refs/tags/v1.0.0
```

The action requires Node.js 24. The example runs `actions/setup-node` first.

## Required secrets and permissions

| Name               | Purpose                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `OPENCODE_API_KEY` | OpenCode Go or Console API key, passed to the model process               |
| `GITHUB_TOKEN`     | Posts the review; the default token with `pull-requests: write` is enough |

The workflow needs:

```yaml
permissions:
  contents: read
  pull-requests: write
```

The action never gives `GITHUB_TOKEN` to the OpenCode process. It runs OpenCode
with a small environment allowlist and disables project config and plugins.

## Inputs

| Input                | Default                           | Meaning                                            |
| -------------------- | --------------------------------- | -------------------------------------------------- |
| `model`              | `opencode-go/deepseek-v4.1-flash` | OpenCode model                                     |
| `opencode-api-key`   | required                          | Go or Console API key                              |
| `github-token`       | empty                             | Posting token; required unless `dry-run` is true   |
| `prompt`             | empty                             | Inline review instructions                         |
| `prompt-file`        | empty                             | Repo-relative path read from the base commit       |
| `max-findings`       | `20`                              | Integer `1..100`                                   |
| `severity-threshold` | `medium`                          | `high`, `medium`, or `low`                         |
| `max-diff-bytes`     | `300000`                          | Maximum UTF-8 diff size. A larger diff is skipped  |
| `timeout-seconds`    | `1500`                            | OpenCode child timeout                             |
| `dry-run`            | `false`                           | Print the payload and do not post                  |
| `force`              | `false`                           | Post even when a review marker exists at this head |
| `opencode-version`   | `2.3.2`                           | Exact OpenCode CLI version                         |

## Outputs

| Output      | Meaning                                                           |
| ----------- | ----------------------------------------------------------------- |
| `findings`  | Inline comments in the review, or the would-post count in dry-run |
| `review-id` | Review id when posted; empty for dry-run and skip                 |
| `posted`    | `true` when a review was posted                                   |
| `skipped`   | `true` when the run was skipped                                   |
| `omitted`   | Findings dropped or truncated by validation                       |

## Trust model

The action is safe for repositories where everyone with write access is trusted.

**Who can run it with secrets.** Only people who can push a branch to the
repository. A PR from a fork gets no secrets and a read-only token, and the
action skips it.

**What a writer can do.** A same-repo PR runs the workflow file from the PR
branch. A writer can edit that file to read `OPENCODE_API_KEY` or to use the
`GITHUB_TOKEN`. This is how GitHub Actions works for every workflow. It is not
specific to this action. CODEOWNERS and branch protection control what is merged
into the default branch. They do not stop a PR branch from running its own
workflow.

**What the action does to limit risk.**

- The action code is pinned by tag or SHA. A PR cannot change it.
- `prompt-file` is read from the base commit. A PR cannot rewrite its own review
  instructions.
- The model runs in a sandbox with no shell, edit, or network tools. It can read
  only tracked files that are not secrets. Text in a diff cannot make it run
  commands.
- The API key is passed only to the OpenCode process. The model cannot read it.

**What you should do.**

1. Use a dedicated OpenCode API key with a spend limit. Rotate it if you suspect
   a leak.
2. Keep write access limited to people you trust.
3. For stricter control, store the key in a GitHub Environment with required
   reviewers and set `environment:` on the job. Each run then needs approval.

The action does not support `pull_request_target`. Do not use it with this
action.

The review is advisory. Do not approve or merge based on it.

## Cost model

The default model is `opencode-go/deepseek-v4.1-flash`. It uses an OpenCode Go
subscription or Console balance. The model has a 1,000,000-token context; the
default 300 KB diff limit is about 150K tokens. The example workflow reviews
`opened`, `synchronize`, `ready_for_review`, and `reopened` events. The action
skips a head that already has a review. Remove `synchronize` to review each PR
only once.

The action downloads the `@opencode/cli` package (about 242 MB) on each job.
The installed tree is larger. Pin the version and cache it only if your runner
supports a safe cache key.

## Custom prompt

Use `prompt` for a short inline instruction:

```yaml
with:
  prompt: "Focus on security and data loss. Ignore naming and formatting."
```

Or use `prompt-file`. The file is read from the **base** commit, not from the PR
head, so a PR cannot rewrite its own review instructions:

```yaml
with:
  prompt-file: .github/opencode-review-prompt.md
```

`prompt` and `prompt-file` cannot be combined. The default prompt ships with the
action.

## Idempotency and re-runs

The review body ends with a hidden marker:

```html
<!-- opencode-pr-review:v2 head=<head-sha> base=<base-sha> -->
```

A re-run at the same head is skipped unless `force: true`. The action paginates
the review list and only trusts the latest review from the bot. A stale or
spoofed marker does not count.

## Security

- Runs OpenCode in a sanitized copy with `.git`, `.opencode`, project config,
  plugins, `AGENTS.md`, `CLAUDE.md`, MCP, skills, and secret files removed.
- Disables project config and Claude compatibility.
- Uses a child environment allowlist; no GitHub token, no action runtime token.
- Denies grep, shell, edit, webfetch, websearch, subagent, and `execute`.
  `grep` cannot be path-scoped, so the action removes it.
- Validates findings against GitHub's own PR patch before posting.
- Redacts secrets and refuses to post a rendered field that contains the key or
  token.
- Sanitizes model output: no images, raw HTML, links, or `@mentions`.

Report vulnerabilities through GitHub private vulnerability reporting, not a
public issue.

## Development

```bash
npm ci --ignore-scripts
npm test
npm run lint
npm run format:check
```

The test suite uses Node's built-in runner. It includes a fake OpenCode binary
and a fake GitHub API for the action smoke test.

## License

MIT. See [LICENSE](LICENSE).
