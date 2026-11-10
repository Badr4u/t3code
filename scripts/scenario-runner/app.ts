// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// Boots the real dev stack of one checkout (server, Vite, replay agent) on a temporary T3 home.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

import type { ScenarioState } from "./scenario.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const START_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 120_000;
export const REPLAY_INSTANCE_ID = "scenarioReplay";

export interface RunningApp {
  /** One-time admin pairing URL on the web origin. Never written to a result or capture. */
  readonly pairingUrl: string;
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

// The server labels its environment with the host's name, probed through these commands.
// Captures must not depend on, or publish, the machine that made them.
const HOST_LABEL_SHIM = `#!/bin/sh
case "$*" in
  "--pretty" | "--get ComputerName") echo "Scenario" ;;
  *) for real in /usr/bin /usr/sbin /bin; do
       [ -x "$real/$(basename "$0")" ] && exec "$real/$(basename "$0")" "$@"
     done
     exit 127 ;;
esac
`;

/** Ambient T3 and Vite variables belong to the developer's own app, not to the app under test. */
function appEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(T3CODE_|T3_|VITE_)/.test(key)) env[key] = value;
  }
  const shims = NodePath.join(home, "bin");
  if (!NodeFS.existsSync(shims)) {
    NodeFS.mkdirSync(shims, { recursive: true });
    for (const command of ["hostnamectl", "scutil"]) {
      NodeFS.writeFileSync(NodePath.join(shims, command), HOST_LABEL_SHIM, { mode: 0o755 });
    }
  }
  return {
    ...env,
    PATH: `${shims}${NodePath.delimiter}${env.PATH ?? ""}`,
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    T3CODE_TELEMETRY_ENABLED: "false",
  };
}

/**
 * Writes settings.json so the app starts with the scenario's settings and the replay provider.
 * The replay agent is the default for new threads, so a step only has to type and send, and for
 * generated text such as titles, so no run reaches a paid model.
 */
export function writeSettings(input: {
  readonly home: string;
  readonly settings: ScenarioState["settings"];
  readonly agentPath: string;
  readonly transcriptPath: string;
}): void {
  const replay = { instanceId: REPLAY_INSTANCE_ID, model: "scenario" };
  const stateDir = NodePath.join(input.home, "userdata");
  NodeFS.mkdirSync(stateDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "settings.json"),
    JSON.stringify(
      {
        providerInstances: {
          [REPLAY_INSTANCE_ID]: {
            driver: "acpRegistry",
            displayName: "Scenario replay",
            config: {
              source: "local",
              commandPath: process.execPath,
              commandArgs: [input.agentPath, "--transcript", input.transcriptPath],
            },
          },
        },
        defaultModelSelection: replay,
        textGenerationModelSelection: replay,
        ...input.settings,
      },
      null,
      2,
    ),
  );
}

export async function startApp(input: {
  readonly appDir: string;
  readonly home: string;
  readonly logPath: string;
}): Promise<RunningApp> {
  const log = NodeFS.createWriteStream(input.logPath);
  // Its own process group: stopping kills the group of the PID spawned here, nothing else.
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["scripts/dev-runner.ts", "dev", "--home-dir", input.home, "--no-seed"],
    {
      cwd: input.appDir,
      env: appEnv(input.home),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stop = async () => {
    if (child.pid !== undefined && child.exitCode === null) {
      process.kill(-child.pid, "SIGTERM");
      const timer = NodeTimersPromises.setTimeout(5_000, "timeout", { ref: false });
      if ((await Promise.race([exited, timer])) === "timeout") process.kill(-child.pid, "SIGKILL");
    }
    log.end();
  };

  const pairingUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The app did not print a pairing URL in ${START_TIMEOUT_MS / 1000}s`)),
      START_TIMEOUT_MS,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The dev runner exited with code ${String(code)} before the app was ready`));
    });
    for (const stream of [child.stdout, child.stderr]) {
      NodeReadline.createInterface({ input: stream }).on("line", (line) => {
        const url = /pairingUrl:\s*(\S+)/.exec(line)?.[1];
        log.write(`${url === undefined ? line : "  pairingUrl: <redacted>"}\n`);
        if (url !== undefined) {
          clearTimeout(timer);
          resolve(url);
        }
      });
    }
  }).catch(async (error: unknown) => {
    await stop();
    throw error;
  });
  return { pairingUrl, origin: new URL(pairingUrl).origin, stop };
}

/** Creates the scenario's projects and threads through the app's own CLI, against the live server. */
export async function seedState(input: {
  readonly appDir: string;
  readonly home: string;
  readonly state: ScenarioState;
}): Promise<void> {
  const cli = (args: ReadonlyArray<string>) =>
    execFile(process.execPath, ["apps/server/src/bin.ts", ...args, "--base-dir", input.home], {
      cwd: input.appDir,
      env: appEnv(input.home),
      timeout: TURN_TIMEOUT_MS,
    });
  const workspaces = new Map<string, string>();
  for (const [index, project] of (input.state.projects ?? []).entries()) {
    const workspace = NodePath.join(input.home, "workspaces", `${index}-${project.title}`);
    for (const [file, content] of Object.entries({ "README.md": "", ...project.files })) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(workspace, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(workspace, file), content);
    }
    const git = (args: ReadonlyArray<string>) => execFile("git", args, { cwd: workspace });
    await git(["init", "--quiet", "--initial-branch=main"]);
    await git(["add", "--all"]);
    const author = ["-c", "user.name=Scenario", "-c", "user.email=scenario@example.invalid"];
    await git([...author, "commit", "--quiet", "--message", "Initial commit"]);
    await cli(["project", "add", workspace, "--title", project.title]);
    workspaces.set(project.title, workspace);
  }
  for (const thread of input.state.threads ?? []) {
    const workspace =
      thread.project === undefined
        ? workspaces.values().next().value
        : workspaces.get(thread.project);
    if (workspace === undefined) {
      throw new Error(`Thread "${thread.title}" needs a project in state.projects`);
    }
    // Exit code 2 means the turn waits for an answer, which is a state a scenario may want.
    const turn = (args: ReadonlyArray<string>) =>
      cli(["thread", ...args, "--wait", "--json"]).catch(
        (error: { code?: unknown; stdout?: string }) => {
          if (error.code !== 2 || error.stdout === undefined) throw error;
          return { stdout: error.stdout };
        },
      );
    const [first = "Start", ...rest] = thread.messages;
    const model = ["--provider", REPLAY_INSTANCE_ID, "--model", "scenario"];
    const started = await turn(["start", workspace, first, "--title", thread.title, ...model]);
    const { threadId } = JSON.parse(started.stdout) as { threadId: string };
    for (const message of rest) await turn(["send", threadId, message]);
  }
}
