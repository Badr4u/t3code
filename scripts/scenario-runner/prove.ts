// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { REPO_ROOT, runScenario, scenarioName, type RunResult, type StepResult } from "./run.ts";

export interface ProofStep {
  readonly name: string;
  readonly base: StepResult["status"];
  readonly head: StepResult["status"];
  readonly baseMessage?: string;
  readonly headMessage?: string;
  readonly baseCapture?: string;
  readonly headCapture?: string;
}

export interface Proof {
  readonly scenario: string;
  readonly title: string;
  /** True only when an expectation failed on base. A run that could not start is not a failure. */
  readonly failsOnBase: boolean;
  readonly passesOnHead: boolean;
  readonly baseSha: string;
  readonly headSha: string;
  /** One sentence saying what the two runs showed. */
  readonly verdict: string;
  readonly steps: ReadonlyArray<ProofStep>;
  /** Capture file paths, base then head, in step order. */
  readonly captures: ReadonlyArray<string>;
  readonly videos: ReadonlyArray<string>;
  /** Paste-ready pull request section. Captures are file names unless they were uploaded. */
  readonly markdown: string;
  readonly base: RunResult;
  readonly head: RunResult;
}

const short = (sha: string) => sha.slice(0, 10);

function verdictOf(base: RunResult, head: RunResult): string {
  const baseSha = `\`${short(base.sha)}\``;
  const headSha = `\`${short(head.sha)}\``;
  if (base.status === "error") {
    return `Not proven: the scenario could not run on base ${baseSha} (${base.message ?? "unknown error"}).`;
  }
  if (head.status === "error") {
    return `Not proven: the scenario could not run on head ${headSha} (${head.message ?? "unknown error"}).`;
  }
  if (base.status === "passed") {
    return head.status === "passed"
      ? `Not proven: the scenario passes on base ${baseSha} too, so it does not reproduce the bug.`
      : `Not proven: the scenario passes on base ${baseSha} and fails on head ${headSha}, so head breaks it.`;
  }
  return head.status === "passed"
    ? `Proven: the scenario fails on base ${baseSha} and passes on head ${headSha}.`
    : `Not proven: the scenario fails on base ${baseSha} and still fails on head ${headSha}.`;
}

const STATUS_LABEL = {
  passed: "✅ passed",
  failed: "❌ failed",
  error: "⚠️ could not run",
  "not-run": "not run",
} as const;

function cell(
  side: string,
  sha: string,
  step: StepResult | undefined,
  link: (path: string) => string,
) {
  if (step === undefined) return "";
  const lines: Array<string> = [STATUS_LABEL[step.status]];
  if (step.message !== undefined) {
    const firstLine = step.message.split("\n")[0] ?? "";
    lines.push(firstLine.replaceAll("|", "\\|").replaceAll("<", "&lt;"));
  }
  if (step.capture !== undefined) {
    lines.push(`![${side} ${short(sha)}: ${step.name}](${link(step.capture)})`);
  }
  return lines.join("<br>");
}

/** `link` maps a capture path to what the Markdown should point at, such as an uploaded URL. */
export function buildProof(
  base: RunResult,
  head: RunResult,
  link: (path: string) => string = (path) => path,
): Proof {
  const steps = head.steps.map((headStep, index): ProofStep => {
    const baseStep = base.steps[index];
    return {
      name: headStep.name,
      base: baseStep?.status ?? "not-run",
      head: headStep.status,
      ...(baseStep?.message === undefined ? {} : { baseMessage: baseStep.message }),
      ...(headStep.message === undefined ? {} : { headMessage: headStep.message }),
      ...(baseStep?.capture === undefined ? {} : { baseCapture: baseStep.capture }),
      ...(headStep.capture === undefined ? {} : { headCapture: headStep.capture }),
    };
  });
  const verdict = verdictOf(base, head);
  const markdown = [
    `### Scenario \`${head.scenario}\``,
    "",
    head.title,
    "",
    `**${verdict}**`,
    "",
    `| Step | Base \`${short(base.sha)}\` | Head \`${short(head.sha)}\` |`,
    "| --- | --- | --- |",
    ...head.steps.map(
      (step, index) =>
        `| ${index + 1}. ${step.name} | ${cell("Base", base.sha, base.steps[index], link)} | ${cell("Head", head.sha, step, link)} |`,
    ),
    "",
  ].join("\n");
  return {
    scenario: head.scenario,
    title: head.title,
    failsOnBase: base.status === "failed",
    passesOnHead: head.status === "passed",
    baseSha: base.sha,
    headSha: head.sha,
    verdict,
    steps,
    captures: [...base.steps, ...head.steps].flatMap((step) => step.capture ?? []),
    videos: [base.video, head.video].flatMap((video) => video ?? []),
    markdown,
    base,
    head,
  };
}

const git = (args: ReadonlyArray<string>, cwd = REPO_ROOT) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Runs `run` in a checkout of `sha`: this one when it already is that commit, else a worktree. */
async function withCheckout<A>(sha: string, run: (appDir: string) => Promise<A>): Promise<A> {
  const clean = git(["status", "--porcelain", "--untracked-files=no"]).length === 0;
  if (clean && git(["rev-parse", "HEAD"]) === sha) return run(REPO_ROOT);
  // Beside this checkout, not in the temp directory, so tooling resolves as it does here.
  const worktree = `${REPO_ROOT}-scenario-${short(sha)}`;
  git(["worktree", "add", "--quiet", "--detach", "--force", worktree, sha]);
  try {
    NodeChildProcess.execFileSync("vp", ["i"], { cwd: worktree, stdio: ["ignore", 2, 2] });
    return await run(worktree);
  } finally {
    git(["worktree", "remove", "--force", worktree]);
  }
}

/** Runs the scenario on `base` and `head`, one after the other, and compares the two results. */
export async function proveScenario(input: {
  readonly scenarioPath: string;
  readonly base: string;
  readonly head: string;
  readonly outDir: string;
  /** A command given the capture paths that prints one URL per line, such as `ghdrop upload`. */
  readonly uploadCommand?: string;
}): Promise<Proof> {
  const results: Array<RunResult> = [];
  for (const [label, rev] of [
    ["base", input.base],
    ["head", input.head],
  ] as const) {
    const sha = git(["rev-parse", "--verify", `${rev}^{commit}`]);
    results.push(
      await withCheckout(sha, (appDir) =>
        runScenario({
          scenarioPath: input.scenarioPath,
          appDir,
          outDir: input.outDir,
          label: `${label}-${short(sha)}`,
        }),
      ),
    );
  }
  const [base, head] = results as [RunResult, RunResult];
  const links = new Map<string, string>();
  const captures = buildProof(base, head).captures;
  if (input.uploadCommand !== undefined && captures.length > 0) {
    const [command, ...args] = input.uploadCommand.split(/\s+/).filter(Boolean);
    const urls = NodeChildProcess.execFileSync(command!, [...args, ...captures], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    for (const [index, capture] of captures.entries()) links.set(capture, urls[index] ?? capture);
  }
  // Without an upload the Markdown sits beside its captures, so it points at them by name.
  const proof = buildProof(
    base,
    head,
    (path) => links.get(path) ?? NodePath.relative(input.outDir, path),
  );
  const name = scenarioName(input.scenarioPath);
  NodeFS.writeFileSync(NodePath.join(input.outDir, `${name}.proof.md`), proof.markdown);
  NodeFS.writeFileSync(
    NodePath.join(input.outDir, `${name}.proof.json`),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  return proof;
}
