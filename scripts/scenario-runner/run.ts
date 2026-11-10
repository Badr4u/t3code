// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { chromium } from "playwright-core";

import { seedState, startApp, writeSettings, type RunningApp } from "./app.ts";
import type { Scenario } from "./scenario.ts";
import { makeUi } from "./ui.ts";

export const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");
const SCENARIOS_DIR = NodePath.join(REPO_ROOT, "scripts/scenarios");
const STEP_TIMEOUT_MS = 15_000;
const DEFAULT_TRANSCRIPT = "apps/server/scripts/dev-replay/showcase_transcript.ndjson";

export interface StepResult {
  readonly name: string;
  /** `failed`: an expectation did not hold. `error`: the step's action could not be done. */
  readonly status: "passed" | "failed" | "error" | "not-run";
  /** The expectation that did not hold, or why the action could not be done. */
  readonly message?: string;
  /** Absolute path of the capture taken after the step. */
  readonly capture?: string;
}

export interface RunResult {
  readonly scenario: string;
  readonly title: string;
  readonly tier: "replay";
  /** The commit of the app that ran, plus `-dirty` when its checkout had changes. */
  readonly sha: string;
  /** `error` means the scenario could not run, which says nothing about the behavior. */
  readonly status: "passed" | "failed" | "error";
  readonly message?: string;
  readonly steps: ReadonlyArray<StepResult>;
  readonly video?: string;
  readonly outDir: string;
}

export function resolveScenarioPath(nameOrPath: string): string {
  const named = NodePath.join(SCENARIOS_DIR, `${nameOrPath}.ts`);
  return NodeFS.existsSync(named) ? named : NodePath.resolve(nameOrPath);
}

export const scenarioName = (scenarioPath: string) => NodePath.basename(scenarioPath, ".ts");

const slug = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 48);

const stripAnsi = (value: string) => value.replaceAll(/\u001B\[[0-9;]*m/g, "");
const errorMessage = (error: unknown) =>
  stripAnsi(error instanceof Error ? error.message : String(error))
    .trim()
    .slice(0, 800);

function checkoutSha(appDir: string): string {
  const git = (args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: appDir, encoding: "utf8" }).trim();
  // Only tracked changes count: run artifacts and an unsaved scenario are not the app.
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).length > 0;
  return `${git(["rev-parse", "HEAD"])}${dirty ? "-dirty" : ""}`;
}

function resolveTranscript(scenarioPath: string, transcript: string): string {
  const beside = NodePath.resolve(NodePath.dirname(scenarioPath), transcript);
  const resolved = NodeFS.existsSync(beside) ? beside : NodePath.resolve(REPO_ROOT, transcript);
  if (!NodeFS.existsSync(resolved)) throw new Error(`Transcript not found: ${transcript}`);
  return resolved;
}

/**
 * Runs one scenario against the app in `appDir`, which may be another checkout than the one
 * holding the scenario and this runner. Captures are named `<label>-<step>.png`.
 */
export async function runScenario(input: {
  readonly scenarioPath: string;
  readonly appDir: string;
  readonly outDir: string;
  readonly label?: string;
}): Promise<RunResult> {
  const name = scenarioName(input.scenarioPath);
  const module = (await import(NodeURL.pathToFileURL(input.scenarioPath).href)) as {
    readonly default: Scenario;
  };
  const scenario = module.default;
  const sha = checkoutSha(input.appDir);
  const prefix = input.label === undefined ? "" : `${input.label}-`;
  NodeFS.mkdirSync(input.outDir, { recursive: true });

  const steps: Array<StepResult> = [];
  let status: RunResult["status"] = "passed";
  let message: string | undefined;
  let video: string | undefined;
  let app: RunningApp | undefined;
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-scenario-"));
  const browser = await chromium.launch();
  try {
    writeSettings({
      home,
      settings: scenario.state?.settings,
      agentPath: NodePath.join(REPO_ROOT, "apps/server/scripts/dev-replay-agent.ts"),
      transcriptPath: resolveTranscript(
        input.scenarioPath,
        scenario.transcript ?? DEFAULT_TRANSCRIPT,
      ),
    });
    app = await startApp({
      appDir: input.appDir,
      home,
      logPath: NodePath.join(input.outDir, `${prefix}app.log`),
    });
    await seedState({ appDir: input.appDir, home, state: scenario.state ?? {} });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: input.outDir, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();
    try {
      // The first load compiles the client; pairing redirects to the app once it is ready.
      await page.goto(app.pairingUrl, { timeout: 180_000 });
      await page.waitForURL((url) => !url.searchParams.has("token"), { timeout: 180_000 });
      const ui = makeUi(page, app.origin, STEP_TIMEOUT_MS);
      for (const [index, step] of scenario.steps.entries()) {
        let result: StepResult & { readonly status: RunResult["status"] } = {
          name: step.name,
          status: "passed",
        };
        try {
          await step.do?.(ui);
          try {
            await step.expect?.(ui);
          } catch (error) {
            result = { name: step.name, status: "failed", message: errorMessage(error) };
          }
        } catch (error) {
          result = { name: step.name, status: "error", message: errorMessage(error) };
        }
        const capture = NodePath.join(
          input.outDir,
          `${prefix}${String(index + 1).padStart(2, "0")}-${slug(step.name)}.png`,
        );
        await page.screenshot({ path: capture }).catch(() => {});
        steps.push(NodeFS.existsSync(capture) ? { ...result, capture } : result);
        if (result.status !== "passed") {
          status = result.status;
          message = `${step.name}: ${result.message ?? ""}`;
          break;
        }
      }
    } finally {
      await context.close();
      const recorded = await page.video()?.path();
      if (recorded !== undefined && NodeFS.existsSync(recorded)) {
        video = NodePath.join(input.outDir, `${prefix}run.webm`);
        NodeFS.renameSync(recorded, video);
      }
    }
  } catch (error) {
    status = "error";
    message = `setup: ${errorMessage(error)}`;
  } finally {
    await browser.close();
    await app?.stop();
    NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }

  for (const step of scenario.steps.slice(steps.length)) {
    steps.push({ name: step.name, status: "not-run" });
  }
  const result: RunResult = {
    scenario: name,
    title: scenario.title,
    tier: "replay",
    sha,
    status,
    ...(message === undefined ? {} : { message }),
    steps,
    ...(video === undefined ? {} : { video }),
    outDir: input.outDir,
  };
  NodeFS.writeFileSync(
    NodePath.join(input.outDir, `${prefix}result.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}
