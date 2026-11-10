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
    {
      name: "Type a repository URL",
      do: (ui) => ui.type({ role: "combobox" }, "https://github.com/pingdotgg/t3code.git"),
      expect: (ui) => ui.enabled(submit),
    },
    {
      name: "Press Tab",
      do: (ui) => ui.press("Tab"),
      expect: (ui) => ui.focused(submit),
    },
  ],
});
