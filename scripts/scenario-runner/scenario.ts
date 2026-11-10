import type { Page } from "playwright-core";

/**
 * What a step points at. A string is visible text. The object forms follow how a user or a
 * screen reader finds a control, so a native driver can resolve them too; `css` is web-only.
 */
export type Target =
  | string
  | { readonly role: Parameters<Page["getByRole"]>[0]; readonly name?: string | RegExp }
  | { readonly label: string | RegExp }
  | { readonly placeholder: string | RegExp }
  | { readonly testId: string }
  | { readonly css: string };

/** The user's hands and eyes. Actions wait for their target; expectations wait to become true. */
export interface Ui {
  /** Opens an app path such as `/settings`. */
  readonly goto: (path: string) => Promise<void>;
  readonly click: (target: Target) => Promise<void>;
  /** Replaces the content of a text field or editor. */
  readonly type: (target: Target, text: string) => Promise<void>;
  /** Presses a key or chord in the focused element, such as `Tab` or `Control+K`. */
  readonly press: (keys: string) => Promise<void>;
  readonly sees: (target: Target) => Promise<void>;
  readonly gone: (target: Target) => Promise<void>;
  readonly focused: (target: Target) => Promise<void>;
  readonly enabled: (target: Target) => Promise<void>;
  readonly disabled: (target: Target) => Promise<void>;
  /** The Playwright page, for what the methods above cannot say. Web-only. */
  readonly page: Page;
}

export interface Step {
  readonly name: string;
  /** What the user does. A throw here means the scenario could not run, not that the bug shows. */
  readonly do?: (ui: Ui) => Promise<unknown>;
  /** What must be true afterwards. A throw here fails the step. */
  readonly expect?: (ui: Ui) => Promise<unknown>;
}

export interface ScenarioState {
  /** Each project is a new git repository holding `files`. The first is the default. */
  readonly projects?: ReadonlyArray<{
    readonly title: string;
    readonly files?: Readonly<Record<string, string>>;
  }>;
  /** Threads that exist before the browser opens. Each message plays the transcript's next turn. */
  readonly threads?: ReadonlyArray<{
    readonly title: string;
    readonly project?: string;
    readonly messages: ReadonlyArray<string>;
  }>;
  /** Merged into the server's settings.json before it starts. */
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface Scenario {
  /** One sentence: the behavior this scenario shows. */
  readonly title: string;
  readonly state?: ScenarioState;
  /**
   * A recorded ACP session (`registry_transcript.ndjson` format) the replay agent plays, one
   * turn per message. A path relative to the scenario file, or to the repository root.
   * Defaults to the dev replay showcase turn.
   */
  readonly transcript?: string;
  readonly steps: ReadonlyArray<Step>;
}

export const defineScenario = (scenario: Scenario): Scenario => scenario;
