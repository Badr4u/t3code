import { defineScenario } from "../scenario-runner/scenario.ts";

const stop = { role: "button", name: "Stop generation" } as const;

export default defineScenario({
  title: "A replayed turn streams a reply, runs tools, and waits for an approval",
  state: {
    projects: [{ title: "demo", files: { "src/math.ts": "export const sum = 1 + 1;\n" } }],
    settings: { defaultRuntimeMode: "approval-required" },
  },
  transcript: "apps/server/scripts/dev-replay/showcase_transcript.ndjson",
  steps: [
    {
      name: "Send a message in a new thread",
      do: async (ui) => {
        await ui.type({ role: "textbox" }, "Give me a short tour");
        await ui.press("Enter");
      },
      expect: async (ui) => {
        await ui.sees("The project has a single math module");
        await ui.sees(stop);
      },
    },
    {
      name: "The agent asks before it edits",
      expect: (ui) => ui.sees({ role: "button", name: "Approve" }),
    },
    {
      name: "Approve the edit",
      do: (ui) => ui.click({ role: "button", name: "Approve" }),
      expect: async (ui) => {
        await ui.sees("This turn is a replay.");
        await ui.gone(stop);
      },
    },
  ],
});
