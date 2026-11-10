// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeTimersPromises from "node:timers/promises";
import type { Locator, Page } from "playwright-core";

import type { Target, Ui } from "./scenario.ts";

const POLL_MS = 100;

export function describeTarget(target: Target): string {
  if (typeof target === "string") return `text "${target}"`;
  if ("role" in target) {
    return target.name === undefined ? target.role : `${target.role} "${String(target.name)}"`;
  }
  if ("label" in target) return `field labelled "${String(target.label)}"`;
  if ("placeholder" in target) return `field with placeholder "${String(target.placeholder)}"`;
  if ("testId" in target) return `test id "${target.testId}"`;
  return `element ${target.css}`;
}

function locate(page: Page, target: Target): Locator {
  // Screen-reader-only copies of a label are not what a sighted user clicks or sees.
  if (typeof target === "string") {
    return page.getByText(target).and(page.locator(":not(.sr-only)"));
  }
  if ("role" in target) {
    // A string name is the whole name: "Add project" must not also match "Add project script".
    return page.getByRole(
      target.role,
      target.name === undefined ? {} : { name: target.name, exact: true },
    );
  }
  if ("label" in target) return page.getByLabel(target.label);
  if ("placeholder" in target) return page.getByPlaceholder(target.placeholder);
  if ("testId" in target) return page.getByTestId(target.testId);
  return page.locator(target.css);
}

// This package typechecks without the DOM library, so page functions name the shape they read.
interface PageElement {
  readonly ownerDocument: { readonly activeElement: unknown };
  readonly tagName: string;
  readonly textContent: string | null;
  readonly getAttribute: (name: string) => string | null;
}

const isFocused = (element: PageElement) => element.ownerDocument.activeElement === element;

const describeFocus = (page: Page) =>
  page
    .locator(":focus")
    .first()
    .evaluate(
      (element: PageElement) => {
        const name = element.getAttribute("aria-label") ?? element.textContent ?? "";
        return `<${element.tagName.toLowerCase()}> "${name.trim().slice(0, 60)}"`;
      },
      undefined,
      { timeout: 1_000 },
    )
    .catch(() => "nothing");

export function makeUi(page: Page, origin: string, timeoutMs: number): Ui {
  const expectation = async (
    target: Target,
    state: string,
    holds: (locator: Locator) => Promise<boolean>,
    actual?: () => Promise<string>,
  ) => {
    const locator = locate(page, target).first();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await holds(locator).catch(() => false)) return;
      if (Date.now() >= deadline) break;
      await NodeTimersPromises.setTimeout(POLL_MS);
    }
    const found = actual === undefined ? "" : `; ${await actual()}`;
    throw new Error(
      `expected ${describeTarget(target)} to be ${state} within ${timeoutMs / 1000}s${found}`,
    );
  };

  return {
    page,
    goto: async (path) => {
      await page.goto(new URL(path, origin).toString());
    },
    click: (target) => locate(page, target).click({ timeout: timeoutMs }),
    type: (target, text) => locate(page, target).fill(text, { timeout: timeoutMs }),
    press: (keys) => page.keyboard.press(keys),
    sees: (target) => expectation(target, "visible", (locator) => locator.isVisible()),
    gone: (target) => expectation(target, "gone", async (locator) => !(await locator.isVisible())),
    focused: (target) =>
      expectation(
        target,
        "focused",
        (locator) => locator.evaluate(isFocused),
        async () => `focus is on ${await describeFocus(page)}`,
      ),
    enabled: (target) => expectation(target, "enabled", (locator) => locator.isEnabled()),
    disabled: (target) => expectation(target, "disabled", (locator) => locator.isDisabled()),
  };
}
