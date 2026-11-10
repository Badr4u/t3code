import { describe, expect, it } from "@effect/vitest";

import { buildProof } from "./prove.ts";
import type { RunResult, StepResult } from "./run.ts";

const run = (sha: string, status: RunResult["status"], last: StepResult): RunResult => ({
  scenario: "tab-order",
  title: "Tab reaches the submit button",
  tier: "replay",
  sha,
  status,
  ...(status === "error" ? { message: "setup: the app did not start" } : {}),
  steps: [{ name: "Open", status: "passed", capture: `/out/${sha}-01.png` }, last],
  outDir: "/out",
});

const passed: StepResult = { name: "Press Tab", status: "passed", capture: "/out/tab.png" };
const failed: StepResult = {
  name: "Press Tab",
  status: "failed",
  message: 'expected button "Continue" to be focused; focus is on <button> "Back"',
};
const errored: StepResult = { name: "Press Tab", status: "error", message: "no such button" };
const notRun: StepResult = { name: "Press Tab", status: "not-run" };

describe("buildProof", () => {
  it.each([
    { base: failed, head: passed, failsOnBase: true, passesOnHead: true, verdict: /^Proven/ },
    // A "fix" for behavior that never happens: the scenario must fail before it can prove.
    {
      base: passed,
      head: passed,
      failsOnBase: false,
      passesOnHead: true,
      verdict: /passes on base/,
    },
    { base: failed, head: failed, failsOnBase: true, passesOnHead: false, verdict: /still fails/ },
    // A scenario that cannot do its action on base shows nothing about the bug.
    {
      base: errored,
      head: passed,
      failsOnBase: false,
      passesOnHead: true,
      verdict: /could not run on base/,
    },
    {
      base: notRun,
      head: passed,
      failsOnBase: false,
      passesOnHead: true,
      verdict: /could not run on base/,
    },
  ])("reports $verdict for base $base.status and head $head.status", (row) => {
    const status = (step: StepResult) =>
      step.status === "passed" ? "passed" : step.status === "failed" ? "failed" : "error";
    const proof = buildProof(
      run("aaaaaaaaaaaa", status(row.base), row.base),
      run("bbbbbbbbbbbb", status(row.head), row.head),
    );
    expect(proof).toMatchObject({ failsOnBase: row.failsOnBase, passesOnHead: row.passesOnHead });
    expect(proof.verdict).toMatch(row.verdict);
  });

  it("labels every capture with its side and commit, and links it through the given mapping", () => {
    const proof = buildProof(
      run("aaaaaaaaaaaa", "failed", failed),
      run("bbbbbbbbbbbb", "passed", passed),
      (path) => `https://files.example/${path.split("/").pop() ?? ""}`,
    );
    expect(proof.captures).toEqual([
      "/out/aaaaaaaaaaaa-01.png",
      "/out/bbbbbbbbbbbb-01.png",
      "/out/tab.png",
    ]);
    expect(proof.markdown).toContain("| Step | Base `aaaaaaaaaa` | Head `bbbbbbbbbb` |");
    expect(proof.markdown).toContain(
      "![Base aaaaaaaaaa: Open](https://files.example/aaaaaaaaaaaa-01.png)",
    );
    expect(proof.markdown).toContain(
      "![Head bbbbbbbbbb: Press Tab](https://files.example/tab.png)",
    );
    // A raw "<button>" would vanish from the rendered table.
    expect(proof.markdown).toContain('focus is on &lt;button> "Back"');
  });
});
