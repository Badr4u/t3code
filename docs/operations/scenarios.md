# Scenarios

A scenario shows one behavior in the real app: a real server on a temporary T3 home, real HTTP
and WebSocket, and a real browser on the real web client. The replay agent stands in for the
model, so a run is free and repeatable. Use one as the proof for a bug fix: it fails on the base
commit and passes on the fix.

Scenarios live in [`scripts/scenarios`](../../scripts/scenarios), one file each. The runner is
[`scripts/scenario.ts`](../../scripts/scenario.ts).

## Write one

```ts
import { defineScenario } from "../scenario-runner/scenario.ts";

const submit = { role: "button", name: "Continue (Enter)" } as const;

export default defineScenario({
  title: "Tab moves from the add-project Git URL field to its submit button",
  state: { projects: [{ title: "demo" }] },
  steps: [
    {
      name: "Open Add project and choose Git URL",
      do: async (ui) => {
        await ui.click({ role: "button", name: "Add project" });
        await ui.click("Git URL");
      },
      expect: (ui) => ui.focused({ role: "combobox" }),
    },
    { name: "Press Tab", do: (ui) => ui.press("Tab"), expect: (ui) => ui.focused(submit) },
  ],
});
```

A scenario has three parts. [`scenario.ts`](../../scripts/scenario-runner/scenario.ts) holds the
types.

- **State** is what exists before the browser opens. `projects` become git repositories holding
  their `files`. `threads` are created through the app's own CLI, and each of their `messages`
  plays one turn of the transcript, so their history is real events, not inserted rows. The
  app marks those messages as sent by an agent.
  `settings` is merged into the server's `settings.json`.
- **Transcript** is the recorded session the replay agent plays, one turn per message, in the
  `registry_transcript.ndjson` format of the
  [replay fixtures](../../apps/server/src/orchestration-v2/testkit/fixtures). Give a path beside
  the scenario or from the repository root. Without one, a message plays the
  [showcase turn](../../apps/server/scripts/dev-replay/showcase_transcript.ndjson). New threads
  default to the replay agent, so a step only types and sends.
- **Steps** are what the user does (`do`) and what must then be true (`expect`). Expectations
  wait up to 15 seconds to become true. A step fails only when its `expect` throws. A throw in
  `do` means the scenario could not run, which proves nothing, so keep checks out of `do`.

Point at controls the way a user finds them: visible text as a string, or `{ role, name }`,
`{ label }`, `{ placeholder }`. A string `name` matches the whole accessible name; pass a regular
expression for a partial match. `ui.page` is the Playwright page for anything else, such as
seeding browser storage or reading a scroll position.

Write the scenario so that it fails for the reported reason. Run it on the base commit and read
the failing expectation and the capture before you trust it.

## Run one

```sh
node scripts/scenario.ts run add-project-tab-reaches-submit
```

It prints a JSON result and writes it to `artifacts/scenarios/<name>/result.json` with a capture
per step, `run.webm`, and the app's log. `--app-dir <checkout>` runs the app from another
checkout, and `--out <dir>` moves the output. `status` is `passed`, `failed` (an expectation did
not hold; the step carries it in `message`), or `error` (the scenario could not run). The exit
code is 0, 1, or 2 in that order.

A run starts the full dev stack, so it takes a minute or more and wants the memory of
`vp run dev`. Run one at a time on a shared machine. The browser is the Chromium that
`node scripts/node_modules/playwright-core/cli.js install --only-shell chromium` installs.

## Prove a fix

```sh
node scripts/scenario.ts prove add-project-tab-reaches-submit \
  --base e509db3a2f^ --head e509db3a2f --upload-command "ghdrop upload"
```

`prove` runs the scenario on both commits and writes `<name>.proof.json` and `<name>.proof.md`
beside the captures. The JSON carries `failsOnBase`, `passesOnHead`, `baseSha`, `headSha`,
`verdict`, the `steps` with each side's status and capture, `captures`, and `markdown`: a table
with base and head captures side by side, each labelled with its commit, ready for a pull request
description. `--upload-command` names a command that takes the capture paths and prints one URL
per line; the Markdown then embeds those URLs. `--head` defaults to `HEAD`.

It exits 0 only when both `failsOnBase` and `passesOnHead` are true. A scenario that passes on
base does not reproduce the bug, and the verdict says so. `failsOnBase` is also false when the
scenario could not run on base, because a broken run is not evidence.

The scenario and the runner always come from your checkout. Each commit's app runs from a
temporary worktree beside your checkout, installed with `vp i` and removed afterwards. A commit
that is your clean `HEAD` runs in place. This lets a new scenario prove a fix against a base that
predates it.

## Other tiers

Only the web client with the replay agent runs today. The format leaves room for two more
without rewriting scenarios:

- **Live provider.** Same state and steps. The runner would set the default model to a real
  provider's cheapest model instead of the replay agent and skip the transcript. Expectations on
  exact reply text would not hold, so a scenario meant for both tiers asserts on structure.
- **Mobile.** Same state and transcript, against a server the leased device pairs with, as
  [mobile behavior](../../scripts/mobile-behavior/README.md) does. Steps that use only the `ui`
  methods can map onto agent-device accessibility selectors. Steps that use `ui.page` or `css`
  targets are web-only.

## In CI

No job runs scenarios. Never run all of them on every pull request: each boots the app. To run
the ones a branch adds or changes:

```sh
git diff --name-only --diff-filter=AM origin/main...HEAD -- scripts/scenarios \
  | xargs -r -n1 node scripts/scenario.ts run
```

A job for this needs the Chromium install step the existing browser-test jobs in
[`ci.yml`](../../.github/workflows/ci.yml) use.

## What a scenario cannot cover

- Desktop shell behavior (menus, windows, IPC) and the mobile app.
- Provider-specific behavior. The replay agent speaks generic ACP: session updates, permission
  requests, and questions. Vendor frames and real tool side effects are not replayed.
- State no command can create, such as a run stopped by a usage limit. A step can seed browser
  storage through `ui.page`, but there is no database fixture hook.
- Timing. Replay streaming is simulated, so a scenario cannot show a performance regression.
- Purely visual bugs. A capture shows them, but an expectation about pixels is not one this
  format can state; use before and after captures as the proof.
