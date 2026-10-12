// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import type {
  ExamplePrompt,
  LaunchEvent,
  LaunchMethod,
  SigninEvent,
  StartHarness,
  StartScreen,
  StartSignals,
  StartStatus,
  TaskSummary,
  WorkspaceSummary,
} from "./types.ts";

/** The sessionStorage key that keeps the token across reloads. */
export const START_TOKEN_KEY = "swamp-start-token";

/** The longest task title, before the ellipsis. */
export const TITLE_MAX = 120;

/**
 * Reads the token from a URL fragment such as `#token=abc`. Returns null
 * when the fragment carries no non-empty token.
 */
export function parseTokenFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return null;
  const token = new URLSearchParams(raw).get("token");
  return token && token.trim() !== "" ? token.trim() : null;
}

const SCREENS: ReadonlySet<string> = new Set<StartScreen>([
  "workspace",
  "task",
  "sign_in",
  "blocked",
  "agent",
  "trust",
  "launched",
  "home",
]);

/**
 * The screen component to render for a status `screen` value. A value this
 * page doesn't know (a newer server) maps to "unknown", never to a guess.
 */
export function screenComponentKey(
  screen: unknown,
): StartScreen | "unknown" {
  return typeof screen === "string" && SCREENS.has(screen)
    ? screen as StartScreen
    : "unknown";
}

/**
 * Orders the example prompts so the ones whose signal is present come
 * first. The order is otherwise stable.
 */
export function orderExamples(
  examples: readonly ExamplePrompt[],
  signals: StartSignals,
): ExamplePrompt[] {
  const relevant = (e: ExamplePrompt) =>
    e.signal !== undefined && signals[e.signal] === true;
  return [
    ...examples.filter(relevant),
    ...examples.filter((e) => !relevant(e)),
  ];
}

/**
 * Splits a task into its title (the first non-empty line, cut to
 * {@link TITLE_MAX} characters) and the rest of the text.
 */
export function splitTask(text: string): { title: string; rest: string } {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() !== "");
  if (index === -1) return { title: "", rest: "" };
  const first = lines[index].trim();
  const title = first.length > TITLE_MAX
    ? `${first.slice(0, TITLE_MAX).trimEnd()}…`
    : first;
  const rest = lines.slice(index + 1).join("\n").trim();
  return { title, rest };
}

/** The first line of an example prompt, shown on its card. */
export function firstLine(text: string): string {
  return splitTask(text).title;
}

/**
 * Reads a stream event's discriminator. Events may name it `kind` (as
 * libswamp does) or `type`; either is accepted.
 */
function eventKind(event: unknown): string | null {
  if (event === null || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  const kind = record.kind ?? record.type;
  return typeof kind === "string" ? kind : null;
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/** Normalises a `start.signin` stream event, or null for one to skip. */
export function toSigninEvent(event: unknown): SigninEvent | null {
  const kind = eventKind(event);
  const record = event as Record<string, unknown>;
  switch (kind) {
    case "device_verification": {
      const complete = str(record, "verificationUriComplete");
      return {
        kind,
        userCode: str(record, "userCode"),
        verificationUri: str(record, "verificationUri"),
        ...(complete !== "" && { verificationUriComplete: complete }),
      };
    }
    case "polling":
    case "securing_session":
      return { kind };
    case "completed":
      return { kind, username: str(record, "username") };
    case "error":
      return { kind, message: str(record, "message") || "Sign-in failed." };
    default:
      return null;
  }
}

/** Normalises a `start.launch` stream event, or null for one to skip. */
export function toLaunchEvent(event: unknown): LaunchEvent | null {
  const kind = eventKind(event);
  const record = event as Record<string, unknown>;
  switch (kind) {
    case "checking":
    case "enrolling":
    case "brief_written":
    case "window_opening":
      return { kind };
    case "launched": {
      const launched: Extract<LaunchEvent, { kind: "launched" }> = {
        kind,
        method: str(record, "method") as LaunchMethod,
        command: str(record, "command"),
      };
      if (typeof record.opened === "boolean") launched.opened = record.opened;
      return launched;
    }
    case "error":
      return { kind, message: str(record, "message") || "Launch failed." };
    default:
      return null;
  }
}

/** The launch progress steps, in order, as the checklist shows them. */
const LAUNCH_STEPS = [
  "checking",
  "enrolling",
  "brief_written",
  "window_opening",
  "launched",
] as const;

export type LaunchStep = typeof LAUNCH_STEPS[number];

/** The resume progress steps: a launch's, without writing the brief. */
const RESUME_STEPS: readonly LaunchStep[] = LAUNCH_STEPS.filter((s) =>
  s !== "brief_written"
);

export type ChecklistItem = {
  step: LaunchStep;
  state: "done" | "active" | "pending";
};

function checklist(
  steps: readonly LaunchStep[],
  reached: LaunchStep | null,
): ChecklistItem[] {
  const at = reached === null ? -1 : steps.indexOf(reached);
  return steps.map((step, i) => ({
    step,
    state: i < at || (i === at && step === "launched")
      ? "done"
      : i === at
      ? "active"
      : "pending",
  }));
}

/**
 * Each checklist step's state, given the furthest step reached so far.
 * Steps before it are done; it is active, or done once it is `launched`.
 */
export function launchChecklist(reached: LaunchStep | null): ChecklistItem[] {
  return checklist(LAUNCH_STEPS, reached);
}

/** {@link launchChecklist} for `start.resume`, which writes no brief. */
export function resumeChecklist(reached: LaunchStep | null): ChecklistItem[] {
  return checklist(RESUME_STEPS, reached);
}

/** The shape a workspace name must have (checked again by the server). */
const WORKSPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** True when `name` is a valid workspace name. */
export function isValidWorkspaceName(name: string): boolean {
  return WORKSPACE_NAME_PATTERN.test(name);
}

/**
 * Why `name` can't be used for a new workspace, or null when it can. An
 * empty name has no message; the create button is just disabled.
 */
export function newWorkspaceNameProblem(
  name: string,
  existing: readonly WorkspaceSummary[],
): string | null {
  if (name === "") return null;
  if (!isValidWorkspaceName(name)) {
    return "Use lowercase letters, digits and dashes";
  }
  if (existing.some((w) => w.name === name)) {
    return "A workspace with that name exists — pick it above or choose " +
      "another name";
  }
  return null;
}

/** Workspaces newest first; ones with no update time go last. */
export function sortWorkspaces(
  workspaces: readonly WorkspaceSummary[],
): WorkspaceSummary[] {
  const time = (w: WorkspaceSummary) => {
    const t = w.updatedAt === null ? NaN : Date.parse(w.updatedAt);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...workspaces].sort((a, b) => time(b) - time(a));
}

/**
 * How long ago `iso` was: "just now", "N units ago" for the last week, else
 * the ISO date (flagged so callers can phrase it). Null when unreadable.
 */
function relativeTime(
  iso: string | null | undefined,
  now: Date,
): { text: string; isDate: boolean } | null {
  if (iso === null || iso === undefined) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  const ago = (n: number, unit: string) => ({
    text: `${n} ${unit}${n === 1 ? "" : "s"} ago`,
    isDate: false,
  });
  if (seconds < 60) return { text: "just now", isDate: false };
  if (seconds < 3600) return ago(Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return ago(Math.floor(seconds / 3600), "hour");
  if (seconds < 7 * 86400) return ago(Math.floor(seconds / 86400), "day");
  return { text: new Date(then).toISOString().slice(0, 10), isDate: true };
}

/**
 * A short "updated" phrase: relative for the last week, else the ISO date.
 * Null when the time is missing or unreadable.
 */
export function updatedLabel(
  updatedAt: string | null,
  now: Date,
): string | null {
  const when = relativeTime(updatedAt, now);
  return when === null ? null : `Updated ${when.text}`;
}

/**
 * A lower-case "launched" phrase for the resume summary: "launched 3 hours
 * ago", or "launched on 2026-09-01" after a week. Null when unreadable.
 */
export function launchedLabel(
  at: string | null | undefined,
  now: Date,
): string | null {
  const when = relativeTime(at, now);
  if (when === null) return null;
  return when.isDate ? `launched on ${when.text}` : `launched ${when.text}`;
}

/**
 * What the workspace holds, as "2 models, 1 workflow", or "Nothing built
 * yet" when both are zero. Null when the server didn't say.
 */
export function contentsLabel(
  contents: StartStatus["contents"],
): string | null {
  if (!contents) return null;
  const { models, workflows } = contents;
  if (models === 0 && workflows === 0) return "Nothing built yet";
  const count = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"}`;
  return `${count(models, "model")}, ${count(workflows, "workflow")}`;
}

/**
 * The home screen's launch button: a workspace not yet trusted on this
 * machine asks for that confirmation with the same click.
 */
export function resumeLaunchLabel(working: boolean, trusted: boolean): string {
  if (working) return "Launching…";
  return trusted ? "Launch agent" : "Trust folder and launch";
}

/** The home screen's one line of guidance for reopening a task's agent. */
export function resumeGuidance(
  harness: StartStatus["harness"],
  briefFile?: string,
): string {
  const name = harness?.displayName ?? "Your agent";
  return harness?.canResume === true
    ? "Pick up the conversation where you left off. " +
      `${name} opens in a new window with your earlier session.`
    : `${name} opens in a new window in this workspace. The task is in ` +
      `${briefFile ?? "its brief under tasks/"} if it needs a reminder.`;
}

/**
 * Splits the harness list into the ones found on this machine (launchable
 * first, otherwise in table order) and the ones that weren't.
 */
export function splitHarnesses(
  list: readonly StartHarness[],
): { available: StartHarness[]; unavailable: StartHarness[] } {
  const found = list.filter((h) => h.found);
  return {
    available: [
      ...found.filter((h) => h.launchable),
      ...found.filter((h) => !h.launchable),
    ],
    unavailable: list.filter((h) => !h.found),
  };
}

/** Which import field a problem belongs to, and what to say about it. */
export interface ImportProblem {
  field: "path" | "name";
  message: string;
}

/**
 * Why the import form can't be sent yet, or null when it can. The name is
 * optional: it's checked only when given.
 */
export function importProblem(
  path: string,
  name: string,
  existingNames: readonly string[],
): ImportProblem | null {
  const trimmedName = name.trim();
  if (trimmedName !== "") {
    if (!isValidWorkspaceName(trimmedName)) {
      return {
        field: "name",
        message: "Use lowercase letters, digits and dashes",
      };
    }
    if (existingNames.includes(trimmedName)) {
      return {
        field: "name",
        message: "A workspace with that name exists — choose another name, " +
          "or leave it empty",
      };
    }
  }
  if (path.trim() === "") {
    return { field: "path", message: "Enter the folder to import" };
  }
  return null;
}

/**
 * `text` shortened to at most `max` characters by replacing its middle with
 * an ellipsis, so both the start and the end stay readable.
 */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ""}`;
}

/**
 * The message for a failed `start.workspace.choose` or
 * `start.workspace.import`, by error code.
 */
export function workspaceChooseError(
  code: string | undefined,
  message: string,
): string {
  switch (code) {
    case "not_found":
      return "There's no folder at that path. Check it and try again.";
    case "not_a_repo":
      return "This isn't a swamp folder.";
    case "name_taken":
      return "A workspace with that name already exists. Choose another " +
        "name.";
    case "invalid_name":
      return "That name isn't allowed. Use lowercase letters, digits and " +
        "dashes.";
    case "not_a_workspace":
      return "That folder exists but isn't a swamp workspace. Choose another " +
        "name.";
    default:
      return startErrorText(code) ??
        (message || "Couldn't open that workspace. Try again.");
  }
}

/**
 * Friendly text for the error codes any `start.*` request can fail with,
 * or null for a code with no special wording.
 */
export function startErrorText(code: string | undefined): string | null {
  switch (code) {
    case "not_signed_in":
      return "Sign in to Swamp Club first. Reload this page to sign in.";
    case "workspace_missing":
      return "That workspace's folder isn't there any more. It may have " +
        "been moved or deleted. Import it from its new location, or pick " +
        "another workspace.";
    case "task_file_exists":
      return "There's already a file at this task's brief path (under " +
        "tasks/) that Swamp didn't write. Move or rename it, then launch " +
        "again.";
    case "registry_unreadable":
      return "Swamp couldn't read its list of workspaces " +
        "(`workspaces.json` in the Swamp config folder). Fix that file, " +
        "then reload this page.";
    default:
      return null;
  }
}

/** Display names for the agent harnesses swamp supports, by tool id. */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  copilot: "Copilot",
  kiro: "Kiro",
  pi: "Pi",
  amp: "Amp",
  antigravity: "Antigravity",
};

/** A tool id's display name; an unknown id is shown as it is. */
export function toolDisplayName(id: string): string {
  return TOOL_DISPLAY_NAMES[id] ?? id;
}

/** Joins names as "A", "A and B" or "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The extra tools `start.harness.choose` should set up: the checked ones,
 * without the picked agent (always set up) or ones already enrolled.
 */
export function extraToolsToSend(
  checked: Iterable<string>,
  picked: string,
  enrolled: readonly string[],
): string[] {
  const out: string[] = [];
  for (const id of checked) {
    if (id === picked || enrolled.includes(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * Whether the agent screen shows the "also set up" agents open. A first
 * launch in a new workspace (nothing set up yet, no extras ticked) folds
 * them away; otherwise they stay open.
 */
export function showExtrasOpen(
  enrolledTools: readonly string[] | undefined,
  tools: readonly string[] | undefined,
): boolean {
  return (enrolledTools ?? []).length > 0 || (tools ?? []).length > 0;
}

/**
 * The agent screen's heading and intro. With one launchable agent there is
 * nothing to pick, so it names that agent; the intro is null while none is
 * known.
 */
export function agentScreenHeading(
  launchableCount: number,
  name: string | undefined,
): { heading: string; intro: string | null } {
  if (launchableCount === 1 && name) {
    return {
      heading: "Your agent",
      intro:
        `Swamp found ${name} on this machine. It opens in a new window and starts on your task.`,
    };
  }
  return {
    heading: "Who should do the work?",
    intro: launchableCount === 0
      ? null
      : `${
        launchableCount === 1
          ? "Swamp found one agent on this machine."
          : `Swamp found ${launchableCount} agents on this machine.`
      } The one you pick opens in a new window and starts on your task.`,
  };
}

/**
 * The trust screen's line naming every tool the workspace is set up for,
 * the harness first. Null when only one tool is involved.
 */
export function setupSummary(
  enrolled: readonly string[] | undefined,
  tools: readonly string[] | undefined,
  harnessId: string | undefined,
): string | null {
  const ids: string[] = [];
  for (const id of [harnessId, ...(enrolled ?? []), ...(tools ?? [])]) {
    if (id !== undefined && id !== "" && !ids.includes(id)) ids.push(id);
  }
  if (ids.length <= 1) return null;
  const names = joinNames(ids.map(toolDisplayName));
  const opens = harnessId ? `${toolDisplayName(harnessId)} opens.` : "";
  return `Swamp sets this workspace up for ${names}.${opens && ` ${opens}`}`;
}

/** At most this many agent tags on a workspace card before "+N". */
const MAX_AGENT_TAGS = 3;

/**
 * The agent tags on a workspace card: every agent it is set up for, the one
 * its task was launched with first, cut to {@link MAX_AGENT_TAGS} with the
 * rest counted and listed for a hover.
 */
export function workspaceAgentTags(summary: WorkspaceSummary): {
  tags: { id: string; name: string; launched: boolean }[];
  more: number;
  moreTitle: string | null;
} {
  const launched = summary.step === "launched" ? summary.harness : null;
  const ids = [...new Set(summary.enrolledTools ?? [])];
  if (launched && !ids.includes(launched)) ids.unshift(launched);
  ids.sort((a, b) => (a === launched ? -1 : b === launched ? 1 : 0));
  const shown = ids.slice(0, MAX_AGENT_TAGS);
  const rest = ids.slice(MAX_AGENT_TAGS);
  return {
    tags: shown.map((id) => ({
      id,
      name: toolDisplayName(id),
      launched: id === launched,
    })),
    more: rest.length,
    moreTitle: rest.length > 0 ? joinNames(rest.map(toolDisplayName)) : null,
  };
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Created 11 Oct", with the year when it isn't this year. */
export function createdLabel(
  createdAt: string | null | undefined,
  now: Date,
): string | null {
  if (!createdAt) return null;
  const t = new Date(createdAt);
  if (Number.isNaN(t.getTime())) return null;
  const day = `${t.getDate()} ${MONTHS.at(t.getMonth())}`;
  return t.getFullYear() === now.getFullYear()
    ? `Created ${day}`
    : `Created ${day} ${t.getFullYear()}`;
}

/**
 * When a task was created, always with its date and time, and how long ago
 * for the last week: "Created 12 Oct, 14:05 · 2 hours ago". The year is
 * added when it isn't this year. Null when the time is missing or
 * unreadable.
 */
export function taskCreatedLabel(
  createdAt: string | null | undefined,
  now: Date,
): string | null {
  if (!createdAt) return null;
  const t = new Date(createdAt);
  if (Number.isNaN(t.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${t.getDate()} ${MONTHS.at(t.getMonth())}${
    t.getFullYear() === now.getFullYear() ? "" : ` ${t.getFullYear()}`
  }`;
  const absolute = `Created ${day}, ${pad(t.getHours())}:${
    pad(t.getMinutes())
  }`;
  const when = relativeTime(createdAt, now);
  return when && !when.isDate ? `${absolute} · ${when.text}` : absolute;
}

/** What a task that hasn't launched is waiting on, by step. */
function unlaunchedStepLabel(step: TaskSummary["step"]): string {
  switch (step) {
    case "agent":
      return "choosing an agent";
    case "trust":
      return "ready to launch";
    default:
      return "writing";
  }
}

/**
 * A task card's status: "Launched 3 hours ago" (or "Launched on
 * 2026-09-01"), else "Not launched — writing" and the like.
 */
export function taskStatusLabel(task: TaskSummary, now: Date): string {
  if (task.step === "launched") {
    const when = relativeTime(task.launchedAt, now);
    if (when === null) return "Launched";
    return when.isDate ? `Launched on ${when.text}` : `Launched ${when.text}`;
  }
  return `Not launched — ${unlaunchedStepLabel(task.step)}`;
}

/**
 * The "All tasks (N)" link back to the workspace's home, from a count of
 * every task. Null when the workspace has none.
 */
export function allTasksLabel(tasks: number | undefined): string | null {
  if (tasks === undefined || !Number.isFinite(tasks) || tasks < 1) {
    return null;
  }
  return `All tasks (${Math.floor(tasks)})`;
}

/**
 * The tools `start.tools.add` should set up: the ticked ones not already
 * enrolled, once each, in tick order.
 */
export function toolsToAdd(
  checked: Iterable<string>,
  enrolled: readonly string[],
): string[] {
  const out: string[] = [];
  for (const id of checked) {
    if (id === "" || enrolled.includes(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** The workspace agents panel's toggle label. */
export function agentsToggleLabel(enrolledCount: number): string {
  const n = Number.isFinite(enrolledCount) && enrolledCount > 0
    ? Math.floor(enrolledCount)
    : 0;
  return `Configured agents (${n})`;
}

/** True when Swamp found the agent here and can start it with a task. */
export function isLaunchable(harness: StartHarness): boolean {
  return harness.found && harness.launchable;
}

/**
 * The agents the home screen offers: configured for the workspace and
 * launchable here, the task's own agent first. The task's agent is listed
 * even when it can't be launched, so the screen can show it as unavailable
 * rather than silently offering another.
 */
export function launchChoices(
  harnesses: readonly StartHarness[],
  enrolled: readonly string[],
  taskHarness: string | null,
): StartHarness[] {
  const usable = harnesses.filter((h) =>
    h.id === taskHarness || (isLaunchable(h) && enrolled.includes(h.id))
  );
  return usable.sort((a, b) =>
    a.id === taskHarness ? -1 : b.id === taskHarness ? 1 : 0
  );
}

/**
 * True when a launch opened a window, rather than offering a command to
 * copy. A launch that doesn't say is taken to have opened one.
 */
export function launchOpened(
  launch: { opened?: boolean; method?: string } | undefined,
): boolean {
  return launch?.opened !== false && launch?.method !== "copy_command";
}

/** True for an `https:` URL, the only kind the page links out to. */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * What a summary names from a workspace's contents: each model as
 * "name · type" and each workflow by name, with how many more there are.
 */
export function contentsNames(contents: StartStatus["contents"]): {
  models: string[];
  moreModels: number;
  workflows: string[];
  moreWorkflows: number;
} | null {
  if (!contents) return null;
  const models = (contents.modelList ?? []).map((m) => {
    const type = m.type.split("/").at(-1) ?? m.type;
    return `${m.name} · ${type}`;
  });
  const workflows = [...(contents.workflowList ?? [])];
  return {
    models,
    moreModels: Math.max(0, contents.models - models.length),
    workflows,
    moreWorkflows: Math.max(0, contents.workflows - workflows.length),
  };
}

/**
 * The workspace name to suggest. The server offers a fresh random name each
 * time the list is read; the page keeps the one it showed first, so the
 * suggestion doesn't change while someone reads, until it is taken.
 */
export function keepSuggestion(
  current: string,
  offered: string,
  taken: readonly string[],
): string {
  return current !== "" && !taken.includes(current) ? current : offered;
}

/**
 * The workspace name a folder gets on import, as the server names it: the
 * folder's name in lowercase, with runs of other characters as one dash.
 */
export function nameFromFolder(folder: string): string {
  const slug = folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ).slice(0, 63).replace(/-+$/, "");
  return slug || "workspace";
}

/**
 * The name an import of `path` defaults to, or null while the path has no
 * folder name to go on yet (empty, `~`, `.` or `..`).
 */
export function importNameFromPath(path: string): string | null {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop() ?? "";
  if (base === "" || base === "~" || base === "." || base === "..") {
    return null;
  }
  return nameFromFolder(base);
}

/** Good first tasks, one shown at random in the empty task box. */
export const FIRST_TASK_IDEAS: readonly string[] = [
  "Tell me which of my EC2 instances have been running for more than 30 days",
  "Summarise yesterday's failed GitHub Actions runs",
  "List the Kubernetes pods restarting in staging",
  "Check which of my domains' TLS certificates expire this month",
  "Find S3 buckets that allow public access",
  "Show me last week's AWS spend by service",
  "List the open pull requests waiting on my review",
  "Find IAM users who haven't logged in for 90 days",
  "Tell me which Docker images in our registry are older than six months",
  "Check our DNS records point where we think they do",
  "List the Terraform resources that drifted from their state",
  "Find unattached EBS volumes I'm still paying for",
  "Summarise this morning's PagerDuty incidents",
  "Tell me which services in staging run an outdated base image",
  "List the cron jobs on my servers and when they last ran",
  "Check which Postgres databases haven't been backed up today",
  "Find Kubernetes deployments without resource limits",
  "Show me the slowest endpoints in yesterday's load balancer logs",
  "List the security groups that open SSH to the whole internet",
  "Tell me which GitHub repos haven't had a commit in a year",
];

/** One first-task idea, picked with `random` (0 ≤ x < 1). */
export function pickFirstTaskIdea(random: number): string {
  const index = Math.min(
    FIRST_TASK_IDEAS.length - 1,
    Math.max(0, Math.floor(random * FIRST_TASK_IDEAS.length)),
  );
  return FIRST_TASK_IDEAS[index];
}
