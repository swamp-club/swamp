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

import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
// The start page's own type: Space Grotesk headings, IBM Plex Sans body.
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import { Logo } from "../../components/Logo";
import { copyText } from "../../components/clipboard.ts";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { RequestError } from "../../client/stream.ts";
import { behaviorNoun, BEHAVIORS_LABEL } from "../../lib/behavior_labels.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { StartClient } from "./client.ts";
import {
  agentScreenHeading,
  agentsToggleLabel,
  allTasksLabel,
  contentsLabel,
  contentsNames,
  createdLabel,
  extraToolsToSend,
  firstLine,
  importNameFromPath,
  importProblem,
  initialAgentPick,
  isHttpsUrl,
  isLaunchable,
  isValidWorkspaceName,
  joinNames,
  keepSuggestion,
  launchChecklist,
  launchChoices,
  launchedLabel,
  launchOpened,
  type LaunchStep,
  middleEllipsis,
  newWorkspaceNameProblem,
  orderExamples,
  parseTokenFromHash,
  pickFirstTaskIdea,
  resumeChecklist,
  resumeGuidance,
  resumeLaunchLabel,
  screenComponentKey,
  setupSummary,
  showExtrasOpen,
  sortWorkspaces,
  splitHarnesses,
  splitTask,
  START_TOKEN_KEY,
  startErrorText,
  taskCreatedLabel,
  taskStatusLabel,
  toLaunchEvent,
  toolDisplayName,
  toolsToAdd,
  toSigninEvent,
  updatedLabel,
  workspaceAgentTags,
  workspaceChooseError,
} from "./helpers.ts";
import type {
  ExamplePrompt,
  HarnessList,
  LaunchEvent,
  SigninEvent,
  StartHarness,
  StartStatus,
  TaskSummary,
  WorkspaceList,
  WorkspaceSummary,
} from "./types.ts";

const EXAMPLES: ExamplePrompt[] = [
  {
    id: "pods",
    signal: "kubeconfig",
    text: "Show me which pods are failing in staging.\n\n" +
      "For each one, include the namespace, how many times it restarted in " +
      "the last 24 hours, and the last error from its logs. Ignore anything " +
      "in kube-system.",
  },
  {
    id: "aws",
    signal: "awsConfig",
    text: "List the VPCs in my dev AWS account.\n\n" +
      "Flag any that have no flow logs enabled, and any default VPC that " +
      "still has resources in it.",
  },
  {
    id: "gha",
    text: "Summarise yesterday's failed GitHub Actions runs.\n\n" +
      "Group them by repository and workflow, show the step that failed and " +
      "the first error line, and call out anything that failed more than " +
      "once.",
  },
];

const STOPPED_MESSAGE =
  "This page has stopped. Run `swamp start` to come back.";

interface PageToken {
  token: string | null;
  /** True when the token came from the URL fragment on this load. */
  fromHash: boolean;
}

let cachedToken: PageToken | undefined;

/**
 * Reads the token once per page load: from the fragment, else from
 * sessionStorage so a reload works. Storing it and clearing the fragment
 * happen in an effect (see {@link Start}).
 */
function readToken(): PageToken {
  if (cachedToken !== undefined) return cachedToken;
  const fromHash = parseTokenFromHash(location.hash);
  if (fromHash) {
    cachedToken = { token: fromHash, fromHash: true };
    return cachedToken;
  }
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(START_TOKEN_KEY);
  } catch {
    // Storage blocked: there is no stored token.
  }
  cachedToken = { token: stored, fromHash: false };
  return cachedToken;
}

/**
 * Drops the stored token once swamp start has gone or refused it. Each
 * `swamp start` mints a new token, so a reload must not offer the old one.
 */
function forgetToken(): void {
  try {
    sessionStorage.removeItem(START_TOKEN_KEY);
  } catch {
    // Storage blocked: nothing was stored.
  }
}

function errorMessage(error: unknown, fallback: string): string {
  const friendly = error instanceof RequestError
    ? startErrorText(error.code)
    : null;
  if (friendly) return friendly;
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Renders text with `backtick` spans as inline code. */
function withCode(text: string): ReactNode[] {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? <code key={i}>{part}</code> : part
  );
}

export function Start() {
  useDocumentTitle("swamp start");
  const [{ token, fromHash }] = useState(readToken);

  // Keep the token for a reload and take it out of the address bar.
  useEffect(() => {
    if (!token || !fromHash) return;
    history.replaceState(null, "", location.pathname + location.search);
    try {
      sessionStorage.setItem(START_TOKEN_KEY, token);
    } catch {
      // Storage blocked: the token lasts for this page load only.
    }
  }, [token, fromHash]);

  if (!token) {
    return (
      <StartFrame>
        <div className="login-card start-card">
          <p className="start-lead">
            {withCode("This page is only available from `swamp start`.")}
          </p>
        </div>
      </StartFrame>
    );
  }

  return <StartSession token={token} />;
}

type Phase = "connecting" | "ready" | "stopped";

function StartSession({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [status, setStatus] = useState<StartStatus | null>(null);
  const [client, setClient] = useState<StartClient | null>(null);

  useEffect(() => {
    const c = new StartClient(StartClient.urlFor(location), token, {
      onReconnect: () => {
        c.request<StartStatus>("start.status")
          .then(setStatus)
          .catch(() => {
            // The next request surfaces the problem on its own screen.
          });
      },
      onStopped: () => {
        forgetToken();
        setPhase("stopped");
      },
    });
    let active = true;
    c.connect()
      .catch((err) => {
        // The socket was refused (a stale token) or swamp start is gone.
        if (active) forgetToken();
        throw err;
      })
      .then(() => c.request<StartStatus>("start.status"))
      .then((s) => {
        if (!active) return;
        setStatus(s);
        setClient(c);
        setPhase("ready");
      })
      .catch(() => {
        if (active) setPhase("stopped");
      });
    return () => {
      active = false;
      c.close();
    };
  }, [token]);

  if (phase === "stopped") {
    return (
      <StartFrame>
        <div className="login-card start-card">
          <p className="start-lead">{withCode(STOPPED_MESSAGE)}</p>
        </div>
      </StartFrame>
    );
  }

  if (phase === "connecting" || !status || !client) {
    return (
      <StartFrame>
        <div className="login-waiting">
          <div className="login-spinner" />
          Connecting to swamp start...
        </div>
      </StartFrame>
    );
  }

  return (
    <StartFrame>
      <ScreenView status={status} client={client} onStatus={setStatus} />
    </StartFrame>
  );
}

/** What the header's wordmark does while a workspace is open. */
interface HeaderHome {
  go: () => void;
  disabled: boolean;
}

/**
 * Where a screen's header parts render: the breadcrumb (all workspaces,
 * this workspace) beside the wordmark, and the signed-in chip on the
 * other side. `setHome` makes the wordmark lead back to all workspaces.
 * The slots are null until the header has mounted.
 */
const HeaderSlot = createContext<{
  crumbs: HTMLElement | null;
  side: HTMLElement | null;
  setHome: (home: HeaderHome | null) => void;
}>({ crumbs: null, side: null, setHome: () => {} });

function StartFrame({ children }: { children: ReactNode }) {
  const [crumbs, setCrumbs] = useState<HTMLElement | null>(null);
  const [side, setSide] = useState<HTMLElement | null>(null);
  const [home, setHome] = useState<HeaderHome | null>(null);
  const brand = (
    <>
      <Logo size="sm" />
      <span className="start-brand-name">Swamp</span>
    </>
  );
  return (
    <div className="login-page start-page">
      <header className="start-header">
        <div className="start-header-inner">
          <div className="start-header-left">
            {home
              ? (
                <button
                  type="button"
                  className="start-brand start-brand-link"
                  onClick={home.go}
                  disabled={home.disabled}
                  aria-label="Swamp: all workspaces"
                  title="All workspaces"
                >
                  {brand}
                </button>
              )
              : <div className="start-brand">{brand}</div>}
            <div className="start-header-crumbs" ref={setCrumbs} />
          </div>
          <div className="start-header-slot" ref={setSide} />
        </div>
      </header>
      <div className="start-container">
        <HeaderSlot.Provider value={{ crumbs, side, setHome }}>
          {children}
        </HeaderSlot.Provider>
      </div>
    </div>
  );
}

/** The first-run steps, in order, and the screens that belong to each. */
const RAIL_STEPS = [
  { label: "Workspace", screens: ["workspace"] },
  { label: "Task", screens: ["task"] },
  { label: "Agent", screens: ["agent"] },
  { label: "Launch", screens: ["trust", "launched"] },
] as const;

/** The step a screen belongs to, or -1 for screens outside the steps. */
function railStep(key: string): number {
  return RAIL_STEPS.findIndex((s) =>
    (s.screens as readonly string[]).includes(key)
  );
}

/** The getting-started steps beside the screen: done, current, to come. */
function StepRail({ current }: { current: number }) {
  return (
    <nav className="start-rail" aria-label="Getting started">
      <ol>
        {RAIL_STEPS.map((step, i) => {
          const state = i < current
            ? "done"
            : i === current
            ? "current"
            : "todo";
          return (
            <li
              key={step.label}
              className={`start-rail-step start-rail-${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="start-rail-mark" aria-hidden="true">
                {state === "done"
                  ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12l4 4L19 6" />
                    </svg>
                  )
                  : i + 1}
              </span>
              <span className="start-rail-label">
                {step.label}
                {state === "done" && <span className="sr-only">(done)</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

interface ScreenProps {
  status: StartStatus;
  client: StartClient;
  onStatus: (status: StartStatus) => void;
}

function ScreenView(props: ScreenProps) {
  const key = screenComponentKey(props.status.screen);
  const root = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);

  // On a screen change, move focus to the new screen's heading so keyboard
  // and screen-reader users land at its start. A screen that focused
  // something itself (the task box) keeps it.
  useEffect(() => {
    const previous = shown.current;
    shown.current = key;
    if (previous === null || previous === key) return;
    const container = root.current;
    if (!container) return;
    const active = document.activeElement;
    if (active && active !== document.body && container.contains(active)) {
      return;
    }
    container.querySelector<HTMLElement>("h2")?.focus();
  }, [key]);

  const step = railStep(key);
  if (step < 0) {
    return (
      <div ref={root} className="start-content start-content-wide">
        {renderScreen(key, props)}
      </div>
    );
  }
  return (
    <div className="start-layout">
      <StepRail current={step} />
      <div ref={root} className="start-content">
        {renderScreen(key, props)}
      </div>
    </div>
  );
}

function renderScreen(
  key: ReturnType<typeof screenComponentKey>,
  props: ScreenProps,
): ReactNode {
  switch (key) {
    case "workspace":
      return <WorkspaceScreen {...props} />;
    case "task":
      return <TaskScreen {...props} />;
    case "sign_in":
      return <SignInScreen {...props} />;
    case "blocked":
      return <BlockedScreen {...props} />;
    case "agent":
      return <AgentScreen {...props} />;
    case "trust":
      return <TrustScreen {...props} />;
    case "launched":
      return <LaunchedScreen {...props} />;
    case "home":
      return <HomeScreen {...props} />;
    case "unknown":
      return (
        <div className="login-card start-card">
          <p className="start-lead">
            {withCode(
              "This page is out of date. Reload it, or run `swamp start` again.",
            )}
          </p>
        </div>
      );
  }
}

/**
 * Arrow-key navigation and a roving tabindex for a group of `role="radio"`
 * buttons. Only the checked option (else the first) is in the tab order;
 * the arrows, Home and End move between enabled options, and selection
 * follows focus. Keys pressed in anything else inside the group (an input)
 * are left alone.
 */
function useRadioGroup(selected: string | null, keys: readonly string[]) {
  const current = selected !== null && keys.includes(selected)
    ? selected
    : keys[0] ?? null;
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (target.getAttribute("role") !== "radio") return;
    const step = e.key === "ArrowDown" || e.key === "ArrowRight"
      ? 1
      : e.key === "ArrowUp" || e.key === "ArrowLeft"
      ? -1
      : 0;
    if (step === 0 && e.key !== "Home" && e.key !== "End") return;
    const radios = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>(
        '[role="radio"]:not(:disabled)',
      ),
    );
    if (radios.length === 0) return;
    const at = radios.indexOf(target);
    const next = e.key === "Home"
      ? radios[0]
      : e.key === "End"
      ? radios[radios.length - 1]
      : radios[(at + step + radios.length) % radios.length];
    e.preventDefault();
    next.focus();
    next.click();
  };
  return {
    onKeyDown,
    tabIndexFor: (key: string) => (key === current ? 0 : -1),
  };
}

/**
 * Lists the agent harnesses on this machine, while `enabled`. `refresh`
 * looks again, showing the list as loading until the reply comes.
 */
function useHarnesses(client: StartClient, enabled = true) {
  const [harnesses, setHarnesses] = useState<StartHarness[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setError(null);
    client.request<HarnessList>("start.harness.list")
      .then((list) => {
        if (!active) return;
        setHarnesses(Array.isArray(list?.harnesses) ? list.harnesses : []);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err, "Couldn't look for agents."));
      });
    return () => {
      active = false;
    };
  }, [client, enabled, checks]);

  const refresh = useCallback(() => {
    setHarnesses(null);
    setChecks((n) => n + 1);
  }, []);

  return { harnesses, error, refresh };
}

/**
 * Runs one status-returning request at a time and keeps its error.
 */
function useAction(
  onStatus: (status: StartStatus) => void,
  describeError?: (error: unknown) => string,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (action: () => Promise<StartStatus>) => {
      setBusy(true);
      setError(null);
      try {
        onStatus(await action());
      } catch (err) {
        setError(
          describeError
            ? describeError(err)
            : errorMessage(err, "Something went wrong. Try again."),
        );
      } finally {
        setBusy(false);
      }
    },
    [onStatus, describeError],
  );
  return { busy, error, run, setError };
}

/** Stands in for `onStatus` on screens whose chips can't switch. */
function ignoreStatus(): void {}

function describeSwitchError(err: unknown): string {
  return errorMessage(err, "Couldn't go back to your workspaces.");
}

/**
 * The header parts of every screen: the breadcrumb beside the wordmark
 * (All workspaces / this workspace) and the signed-in chip. Once a
 * workspace is chosen, the wordmark and "All workspaces" lead back to the
 * workspace list, and the workspace's name to its tasks. Screens that can't
 * leave (sign-in, blocked) pass no client, so nothing there is a link.
 */
function StatusChips(
  {
    status,
    client,
    onStatus,
    disabled = false,
    confirmSwitch = false,
  }: {
    status: StartStatus;
    client?: StartClient;
    onStatus?: (status: StartStatus) => void;
    /** True while the screen is busy; Switch waits for it. */
    disabled?: boolean;
    /** True when switching would throw away unsaved typing. */
    confirmSwitch?: boolean;
  },
) {
  const { busy: switching, error: switchError, run } = useAction(
    onStatus ?? ignoreStatus,
    describeSwitchError,
  );
  const [confirming, setConfirming] = useState(false);
  const header = useContext(HeaderSlot);
  const signedIn = status.signedIn === "signed_in" && status.username;
  const canSwitch = client !== undefined && onStatus !== undefined &&
    status.workspaceName !== null;
  // From a task's steps back to the workspace's task list; not while unsaved
  // text would be lost (leaving the workspace asks first).
  const showTasksLink = status.screen !== "home" && !confirmSwitch &&
    (status.tasks?.length ?? 0) > 0;
  const leave = () => {
    setConfirming(false);
    if (!client) return;
    void run(() => client.request<StartStatus>("start.workspace.leave"));
  };
  const requestLeave = () => (confirmSwitch ? setConfirming(true) : leave());
  const showTasks = () => {
    if (client) {
      void run(() => client.request<StartStatus>("start.tasks.show"));
    }
  };

  // The wordmark leads back to all workspaces, as the breadcrumb does.
  const requestLeaveRef = useRef(requestLeave);
  requestLeaveRef.current = requestLeave;
  const homeDisabled = disabled || switching || confirming;
  const { setHome } = header;
  useEffect(() => {
    if (!canSwitch) return;
    setHome({ go: () => requestLeaveRef.current(), disabled: homeDisabled });
    return () => setHome(null);
  }, [canSwitch, homeDisabled, setHome]);

  if (!signedIn && !status.workspaceName) return null;
  const crumbs = status.workspaceName && (
    <nav className="start-crumbs" aria-label="Breadcrumb">
      <ol>
        <li>
          {canSwitch
            ? (
              <button
                type="button"
                className="start-crumb-link"
                onClick={requestLeave}
                disabled={homeDisabled}
              >
                {switching ? "Switching…" : "All workspaces"}
              </button>
            )
            : <span>All workspaces</span>}
        </li>
        <li>
          {canSwitch && showTasksLink
            ? (
              <button
                type="button"
                className="start-crumb-link start-crumb-workspace"
                onClick={showTasks}
                disabled={disabled || switching}
                aria-label={`${status.workspaceName}: back to this workspace's tasks`}
                title="Back to this workspace's tasks"
              >
                {status.workspaceName}
              </button>
            )
            : (
              <span
                className="start-crumb-workspace"
                title={status.workspacePath ?? undefined}
                aria-current={status.screen === "home" ? "page" : undefined}
              >
                {status.workspaceName}
              </span>
            )}
        </li>
      </ol>
    </nav>
  );
  const chips = signedIn && (
    <div className="start-chips">
      <div className="start-chip start-chip-user">
        <span className="start-chip-dot" aria-hidden="true" />
        Signed in as {status.username}
      </div>
    </div>
  );
  return (
    <>
      {header.crumbs ? createPortal(crumbs, header.crumbs) : crumbs}
      {header.side ? createPortal(chips, header.side) : chips}
      {confirming && (
        <div
          className="start-warning start-confirm"
          role="group"
          aria-label="Discard your task?"
        >
          <span>Discard your task?</span>
          <button
            type="button"
            className="start-secondary start-small"
            onClick={leave}
          >
            Discard and leave
          </button>
          <button
            type="button"
            className="start-primary start-small"
            autoFocus
            onClick={() => setConfirming(false)}
          >
            Keep editing
          </button>
        </div>
      )}
      <ErrorBox message={switchError} />
    </>
  );
}

function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="login-error" role="alert">{message}</div>;
}

function describeChooseError(err: unknown): string {
  return workspaceChooseError(
    err instanceof RequestError ? err.code : undefined,
    err instanceof Error ? err.message : "",
  );
}

/**
 * Sentinel option values for the pickers. Each starts with a NUL, which no
 * workspace name or task id can contain.
 */
const NEW_WORKSPACE = "\u0000new-workspace";
const IMPORT_WORKSPACE = "\u0000import-workspace";

/** What Swamp is, in one line, under "Welcome to Swamp". */
const SWAMP_ONE_LINER =
  "Swamp turns what you'd do by hand into automation your AI agent builds, runs and keeps.";

const WORKSPACE_EXPLAINER =
  "A workspace holds the automations your agent builds: its behaviors, workflows and the results of every run.";

const IMPORT_FOLDER_HINT = "Choose a folder that's already a swamp folder.";

/** Longest folder path shown on a workspace card before it's shortened. */
const CARD_PATH_MAX = 60;

const WORKSPACE_LOCATION_HINT =
  "Workspaces live in `~/.swamp/workspaces` on this machine. No Git needed.";

/** Error codes from an import that are about the name, not the folder. */
const IMPORT_NAME_ERRORS = new Set(["name_taken", "invalid_name"]);

function WorkspaceScreen({ status, client, onStatus }: ScreenProps) {
  const [list, setList] = useState<WorkspaceSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // What the person typed; empty means "use the suggested name".
  const [name, setName] = useState("");
  const [suggested, setSuggested] = useState("");
  // The first-run layout. Set by the first load, and re-checked later only
  // while nothing is typed (or when the tab regains focus), so the page
  // never changes layout under someone typing.
  const [firstRun, setFirstRun] = useState(false);
  const { busy: choosing, error, run } = useAction(
    onStatus,
    describeChooseError,
  );
  // The import form: its folder and optional name, and its own error so it
  // can be shown under the field it is about.
  const [importPath, setImportPath] = useState("");
  // The server's check of the folder typed or chosen for import: a tick
  // when it holds a .swamp.yaml, else why it can't be imported.
  const [folderCheck, setFolderCheck] = useState<
    | { path: string; state: "checking" }
    | { path: string; state: "ok"; registeredAs?: string }
    | { path: string; state: "error"; message: string }
    | null
  >(null);
  const checkFolder = useCallback(async (typed: string) => {
    const path = typed.trim();
    if (path === "") {
      setFolderCheck(null);
      return;
    }
    setFolderCheck({ path, state: "checking" });
    try {
      const result = await client.request<
        | { ok: true; path: string; registeredAs?: string }
        | { ok: false; message: string }
      >("start.folder.check", { path });
      setFolderCheck((current) =>
        current?.path !== path
          ? current
          : result.ok
          ? { path, state: "ok", registeredAs: result.registeredAs }
          : { path, state: "error", message: result.message }
      );
    } catch (err) {
      setFolderCheck((current) =>
        current?.path !== path ? current : {
          path,
          state: "error",
          message: errorMessage(err, "Couldn't check that folder."),
        }
      );
    }
  }, [client]);
  // Check as the user types, once they pause.
  useEffect(() => {
    if (importPath.trim() === "") {
      setFolderCheck(null);
      return;
    }
    const timer = setTimeout(() => void checkFolder(importPath), 400);
    return () => clearTimeout(timer);
  }, [importPath, checkFolder]);
  const [importName, setImportName] = useState("");
  // The machine's own folder chooser, opened by the server.
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [importErrorField, setImportErrorField] = useState<"path" | "name">(
    "path",
  );
  const describeImportError = useCallback((err: unknown) => {
    const code = err instanceof RequestError ? err.code : undefined;
    setImportErrorField(
      code !== undefined && IMPORT_NAME_ERRORS.has(code) ? "name" : "path",
    );
    return describeChooseError(err);
  }, []);
  const {
    busy: importing,
    error: importError,
    run: runImport,
    setError: setImportError,
  } = useAction(onStatus, describeImportError);
  const busy = choosing || importing;
  const typed = name !== "" || importPath !== "" || importName !== "";
  const typedRef = useRef(typed);
  useEffect(() => {
    typedRef.current = typed;
  }, [typed]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const reply = await client.request<WorkspaceList>(
        "start.workspaces.list",
      );
      return {
        workspaces: Array.isArray(reply?.workspaces)
          ? sortWorkspaces(reply.workspaces)
          : [],
        suggestedName: typeof reply?.suggestedName === "string"
          ? reply.suggestedName
          : "",
      };
    };
    const apply = (
      { workspaces, suggestedName }: Awaited<ReturnType<typeof load>>,
      relayout: boolean,
    ) => {
      // An unchanged list keeps its array, so a refresh that finds nothing
      // new doesn't re-render the screen under the user's pointer.
      setList((prev) =>
        prev !== null && JSON.stringify(prev) === JSON.stringify(workspaces)
          ? prev
          : workspaces
      );
      // Keep the suggestion shown first; the server offers a new one each read.
      setSuggested((prev) =>
        keepSuggestion(prev, suggestedName, workspaces.map((w) => w.name))
      );
      setListError(null);
      if (relayout) setFirstRun(workspaces.length === 0);
      // Keep the choice while it is still listed; else pick up where you
      // left off: the newest workspace.
      setSelected((prev) =>
        prev === NEW_WORKSPACE || prev === IMPORT_WORKSPACE ||
          (prev !== null && workspaces.some((w) => w.name === prev))
          ? prev
          : workspaces[0]?.name ?? NEW_WORKSPACE
      );
    };
    load()
      .then((reply) => {
        if (active) apply(reply, true);
      })
      .catch((err) => {
        if (active) {
          setListError(errorMessage(err, "Couldn't list your workspaces."));
        }
      });
    // Keep the list current (another swamp start opening or closing a
    // workspace) whenever the tab comes back into view, and every so often.
    const refresh = (regained: boolean) => {
      if (document.visibilityState !== "visible") return;
      load()
        .then((reply) => {
          if (active) apply(reply, regained || !typedRef.current);
        })
        .catch(() => {});
    };
    const onFocus = () => refresh(true);
    globalThis.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const poll = setInterval(() => refresh(false), 10_000);
    return () => {
      active = false;
      clearInterval(poll);
      globalThis.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [client]);

  const choose = (chosen: string) =>
    void run(() =>
      client.request<StartStatus>("start.workspace.choose", { name: chosen })
    );

  const existing = list ?? [];
  const radio = useRadioGroup(selected, [
    ...existing.map((w) => w.name),
    NEW_WORKSPACE,
    IMPORT_WORKSPACE,
  ]);
  const trimmed = name.trim();
  const finalName = trimmed || suggested;
  const suggestedTaken = trimmed === "" && suggested !== "" &&
    existing.some((w) => w.name === suggested);
  const problem = trimmed === ""
    ? (suggestedTaken
      ? `A workspace called ${suggested} already exists. Type another name.`
      : null)
    : newWorkspaceNameProblem(trimmed, existing);
  const nameOk = isValidWorkspaceName(finalName) &&
    newWorkspaceNameProblem(finalName, existing) === null;
  const importingSelected = selected === IMPORT_WORKSPACE;
  const creating = firstRun ? !importingSelected : selected === NEW_WORKSPACE;
  const importCheck = importProblem(
    importPath,
    importName,
    existing.map((w) => w.name),
  );
  const importPathError = importErrorField === "path" ? importError : null;
  const importNameError =
    (importCheck?.field === "name" ? importCheck.message : null) ??
      (importErrorField === "name" ? importError : null);
  const folderOk = folderCheck?.state === "ok" &&
    folderCheck.path === importPath.trim();
  const canSubmit = !busy &&
    (importingSelected
      ? importCheck === null && folderOk
      : creating
      ? nameOk
      : existing.some((w) => w.name === selected));
  const now = new Date();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (importingSelected) {
      const path = importPath.trim();
      const chosenName = importName.trim();
      void runImport(() =>
        client.request<StartStatus>(
          "start.workspace.import",
          chosenName ? { path, name: chosenName } : { path },
        )
      );
    } else if (creating) choose(finalName);
    else if (selected !== null) choose(selected);
  };

  const nameFields = (
    <div className="start-new-workspace">
      <label className="start-field-label" htmlFor="start-workspace-name">
        {firstRun ? "Name your workspace" : "Name"}
      </label>
      <p className="start-hint">
        Name it after the project or team it's for
        {suggested && !suggestedTaken
          ? (
            <>
              , or leave it empty to use <code>{suggested}</code>
            </>
          )
          : ""}.
      </p>
      <div className="start-name-row">
        <input
          id="start-workspace-name"
          className="start-input"
          value={name}
          placeholder={suggestedTaken ? "" : suggested}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problem !== null}
          aria-describedby={problem
            ? "start-workspace-name-problem"
            : undefined}
        />
      </div>
      {problem && (
        <div id="start-workspace-name-problem" className="start-field-error">
          {problem}
        </div>
      )}
    </div>
  );

  const browse = async () => {
    setPicking(true);
    setPickError(null);
    try {
      const { path } = await client.request<{ path: string | null }>(
        "start.folder.pick",
      );
      if (path) {
        setImportPath(path);
        setImportError(null);
        void checkFolder(path);
      }
    } catch (err) {
      setPickError(errorMessage(err, "Couldn't open the folder chooser."));
    } finally {
      setPicking(false);
    }
  };

  const importFields = (
    <div className="start-new-workspace start-import-workspace">
      <label className="start-field-label" htmlFor="start-import-path">
        Folder
      </label>
      <div className="start-name-row">
        <input
          id="start-import-path"
          className="start-input start-input-mono"
          value={importPath}
          placeholder="~/code/my-project"
          onChange={(e) => {
            setImportPath(e.target.value);
            setImportError(null);
          }}
          onBlur={() => void checkFolder(importPath)}
          autoComplete="off"
          spellCheck={false}
          required
          aria-invalid={importPathError !== null}
          aria-describedby={importPathError
            ? "start-import-path-hint start-import-path-problem"
            : "start-import-path-hint"}
        />
        {status.canPickFolder && (
          <button
            type="button"
            className="start-secondary"
            onClick={() => void browse()}
            disabled={picking || importing}
          >
            {picking ? "Choosing…" : "Browse…"}
          </button>
        )}
      </div>
      {pickError && (
        <div className="start-field-error" role="alert">
          {withCode(pickError)}
        </div>
      )}
      {!importPathError && folderCheck?.path === importPath.trim() &&
        folderCheck.state === "ok" && (
        <div className="start-field-ok" role="status">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 12l4 4L19 6" />
          </svg>
          {folderCheck.registeredAs
            ? `Swamp repo found. It's already your workspace "${folderCheck.registeredAs}".`
            : "Swamp repo found."}
        </div>
      )}
      {!importPathError && folderCheck?.path === importPath.trim() &&
        folderCheck.state === "checking" && (
        <div className="start-hint" role="status">Checking the folder…</div>
      )}
      {!importPathError && folderCheck?.path === importPath.trim() &&
        folderCheck.state === "error" && (
        <div className="start-field-error" role="alert">
          {withCode(folderCheck.message)}
        </div>
      )}
      {importPathError && (
        <div
          id="start-import-path-problem"
          className="start-field-error"
          role="alert"
        >
          {withCode(importPathError)}
        </div>
      )}
      {folderCheck?.path !== importPath.trim() && (
        <p id="start-import-path-hint" className="start-hint">
          {withCode(IMPORT_FOLDER_HINT)}
        </p>
      )}
      <label className="start-field-label" htmlFor="start-import-name">
        Name <span className="start-field-optional">(optional)</span>
      </label>
      <div className="start-name-row">
        <input
          id="start-import-name"
          className="start-input"
          value={importName}
          placeholder={importNameFromPath(importPath) ??
            "Defaults to the folder name"}
          onChange={(e) => {
            setImportName(e.target.value);
            setImportError(null);
          }}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={importNameError !== null}
          aria-describedby={importNameError
            ? "start-import-name-problem"
            : undefined}
        />
      </div>
      {importNameError && (
        <div
          id="start-import-name-problem"
          className="start-field-error"
          role="alert"
        >
          {importNameError}
        </div>
      )}
    </div>
  );

  const submitLabel = importingSelected
    ? (busy ? "Importing…" : "Import workspace")
    : busy
    ? (creating ? "Creating…" : "Opening…")
    : firstRun
    ? "Create workspace and continue"
    : creating
    ? "Create workspace"
    : selected && existing.some((w) => w.name === selected)
    ? `Continue in ${selected}`
    : "Continue";

  return (
    <div className="login-card start-card">
      <StatusChips status={status} client={client} onStatus={onStatus} />
      {list === null || firstRun
        ? (
          <div className="start-hero">
            <div className="start-eyebrow">Welcome to Swamp</div>
            <h2 tabIndex={-1}>Automate the work you keep doing by hand.</h2>
            <p className="start-lead">{SWAMP_ONE_LINER}</p>
          </div>
        )
        : (
          <h2 tabIndex={-1}>
            Welcome back{status.username ? `, ${status.username}` : ""}
          </h2>
        )}
      <ErrorBox message={error ?? listError} />
      {list === null && !listError && (
        <div className="login-waiting">
          <div className="login-spinner" />
          Looking for your workspaces…
        </div>
      )}
      {list !== null && (
        <form
          className={`start-workspace-form${firstRun ? " start-panel" : ""}`}
          onSubmit={submit}
        >
          {firstRun
            ? (
              <>
                {!importingSelected && (
                  <p className="start-panel-intro">{WORKSPACE_EXPLAINER}</p>
                )}
                {importingSelected
                  ? (
                    <>
                      {importFields}
                      <p className="start-hint start-switch-form">
                        <button
                          type="button"
                          className="start-link"
                          onClick={() => setSelected(NEW_WORKSPACE)}
                        >
                          Back
                        </button>
                      </p>
                    </>
                  )
                  : (
                    <>
                      {nameFields}
                      <p className="start-hint start-switch-form">
                        Already have a swamp repo?{" "}
                        <button
                          type="button"
                          className="start-link"
                          onClick={() => setSelected(IMPORT_WORKSPACE)}
                        >
                          Import it →
                        </button>
                      </p>
                    </>
                  )}
              </>
            )
            : (
              <>
                <p>Pick up where you left off, or start a new workspace.</p>
                <div
                  className="start-workspaces"
                  role="radiogroup"
                  aria-label="Workspaces"
                  onKeyDown={radio.onKeyDown}
                >
                  {existing.map((w) => (
                    <WorkspaceCard
                      key={w.name}
                      workspace={w}
                      now={now}
                      selected={selected === w.name}
                      tabIndex={radio.tabIndexFor(w.name)}
                      onSelect={() => setSelected(w.name)}
                    />
                  ))}
                  <div
                    className={`start-harness start-new-option${
                      selected === NEW_WORKSPACE
                        ? " start-harness-selected"
                        : ""
                    }`}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected === NEW_WORKSPACE}
                      tabIndex={radio.tabIndexFor(NEW_WORKSPACE)}
                      className="start-new-option-head"
                      onClick={() => setSelected(NEW_WORKSPACE)}
                    >
                      <span className="start-harness-name">
                        Start a new workspace
                      </span>
                      <span className="start-workspace-task">
                        For a different project or task. We'll suggest a name.
                      </span>
                    </button>
                    {selected === NEW_WORKSPACE && nameFields}
                  </div>
                  <div
                    className={`start-harness start-new-option${
                      importingSelected ? " start-harness-selected" : ""
                    }`}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={importingSelected}
                      tabIndex={radio.tabIndexFor(IMPORT_WORKSPACE)}
                      className="start-new-option-head"
                      onClick={() => setSelected(IMPORT_WORKSPACE)}
                    >
                      <span className="start-harness-name">
                        Import an existing workspace
                      </span>
                      <span className="start-workspace-task">
                        Use a swamp repo you already have, where it is. Nothing
                        is moved.
                      </span>
                    </button>
                    {importingSelected && importFields}
                  </div>
                </div>
              </>
            )}
          <div className="start-actions">
            <button
              type="submit"
              className="start-primary"
              disabled={!canSubmit}
            >
              {submitLabel}
            </button>
          </div>
          {firstRun && !importingSelected && (
            <p className="start-hint">{withCode(WORKSPACE_LOCATION_HINT)}</p>
          )}
        </form>
      )}
      {list !== null && firstRun && <FirstRunSteps />}
    </div>
  );
}

/** A small stroke icon for the first-run steps. */
function StepIcon({ path }: { path: string }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

/** What happens after the workspace: the rest of getting started. */
function FirstRunSteps() {
  return (
    <ol className="start-next-steps" aria-label="What happens next">
      <li>
        <StepIcon path="M4 6h16M4 12h10M4 18h7" />
        <b>Describe it</b>
        <span>In your own words, as much detail as you like.</span>
      </li>
      <li>
        <StepIcon path="M4 5h16v12H4zM8 10l3 2.5L8 15M13 15h3" />
        <b>Pick your agent</b>
        <span>Claude Code, Codex, Cursor and more.</span>
      </li>
      <li>
        <StepIcon path="M5 12l4 4L19 6" />
        <b>Watch it work</b>
        <span>It opens in a new window and gets to work.</span>
      </li>
    </ol>
  );
}

function WorkspaceCard(
  { workspace, now, selected, tabIndex, onSelect }: {
    workspace: WorkspaceSummary;
    now: Date;
    selected: boolean;
    tabIndex: number;
    onSelect: () => void;
  },
) {
  const updated = updatedLabel(workspace.updatedAt, now);
  const created = createdLabel(workspace.createdAt, now);
  const agents = workspaceAgentTags(workspace);
  const dates = [created, updated].filter((d): d is string => d !== null);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabIndex}
      className={`start-harness start-workspace${
        selected ? " start-harness-selected" : ""
      }`}
      onClick={onSelect}
      title={workspace.path}
    >
      <span className="start-workspace-head">
        <span className="start-workspace-name">{workspace.name}</span>
        <span className="start-agent-tags">
          {agents.tags.length === 0 && (
            <span className="start-agent-tag-chip start-agent-tag-none">
              No agent yet
            </span>
          )}
          {agents.tags.map((t) => (
            <span
              key={t.id}
              className={`start-agent-tag-chip${
                t.launched ? " start-agent-tag-launched" : ""
              }`}
              title={t.launched
                ? `Launched with ${t.name}`
                : `Set up for ${t.name}`}
            >
              <AgentBadge id={t.id} />
              {t.name}
            </span>
          ))}
          {agents.more > 0 && (
            <span
              className="start-agent-tag-chip"
              title={agents.moreTitle ?? undefined}
            >
              +{agents.more}
            </span>
          )}
        </span>
      </span>
      {workspace.imported && (
        <span className="start-workspace-path">
          {middleEllipsis(workspace.path, CARD_PATH_MAX)}
        </span>
      )}
      <span className="start-workspace-brief">
        <span className="start-workspace-label">Brief</span>
        <span
          className={`start-workspace-task${
            workspace.taskTitle ? "" : " start-workspace-task-empty"
          }`}
        >
          {workspace.taskTitle ?? "No brief yet"}
        </span>
      </span>
      {dates.length > 0 && (
        <span className="start-workspace-dates">{dates.join(" · ")}</span>
      )}
      {workspace.running && (
        <span className="start-harness-note">
          Also open in another swamp start
        </span>
      )}
    </button>
  );
}

function TaskScreen({ status, client, onStatus }: ScreenProps) {
  const [text, setText] = useState(status.task?.text ?? "");
  const { busy, error, run } = useAction(onStatus);
  const examples = orderExamples(EXAMPLES, status.signals);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // One idea per visit, so the placeholder doesn't change while shown.
  const [idea] = useState(() => pickFirstTaskIdea(Math.random()));
  // Typed text that Continue hasn't saved yet; Switch asks before losing it.
  const unsaved = text.trim() !== "" && text !== (status.task?.text ?? "");
  const taskCount = status.tasks?.length ?? 0;
  // A new task in a workspace that has others: Cancel goes back to them.
  const nextTask = status.taskId === undefined && taskCount > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    void run(() => client.request<StartStatus>("start.task.save", { text }));
  };

  return (
    <form className="login-card start-card" onSubmit={submit}>
      <StatusChips
        status={status}
        client={client}
        onStatus={onStatus}
        disabled={busy}
        confirmSwitch={unsaved}
      />
      {nextTask
        ? (
          <>
            <h2 tabIndex={-1}>What's the next task?</h2>
            <p>
              It gets its own brief under <code>tasks/</code> in{" "}
              {status.workspaceName ?? "this workspace"}. Your other tasks stay
              as they are.
            </p>
          </>
        )
        : (
          <>
            <h2 tabIndex={-1}>What do you want Swamp to do?</h2>
            <p>
              Write as much as you like. All of it goes into the brief for your
              agent.
            </p>
          </>
        )}
      <ErrorBox message={error} />
      <textarea
        ref={textareaRef}
        className="start-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        autoFocus
        aria-label="Your task"
        placeholder={`e.g. ${idea}`}
      />
      <div className="start-examples-label">
        Need an idea? Start from one of these.
      </div>
      <div className="start-examples">
        {examples.map((example) => (
          <button
            key={example.id}
            type="button"
            className="start-example"
            onClick={() => {
              setText(example.text);
              textareaRef.current?.focus();
            }}
          >
            {firstLine(example.text)}
          </button>
        ))}
      </div>
      <div className="start-actions">
        <AllTasksLink
          count={taskCount}
          disabled={busy}
          onClick={() =>
            void run(() => client.request<StartStatus>("start.tasks.show"))}
        />
        {nextTask && (
          <button
            type="button"
            className="start-secondary"
            disabled={busy}
            onClick={() =>
              void run(() =>
                client.request<StartStatus>("start.new_task.cancel")
              )}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="start-primary"
          disabled={busy || !text.trim()}
        >
          {busy ? "Saving..." : "Continue"}
        </button>
      </div>
    </form>
  );
}

/**
 * The quiet "All tasks (N)" link back to the workspace's home, shown once
 * the workspace has a task.
 */
function AllTasksLink(
  { count, disabled, onClick }: {
    count: number | undefined;
    disabled: boolean;
    onClick: () => void;
  },
) {
  const label = allTasksLabel(count);
  if (label === null) return null;
  return (
    <span className="start-actions-left">
      <button
        type="button"
        className="start-link"
        disabled={disabled}
        onClick={onClick}
      >
        {label}
      </button>
    </span>
  );
}

/**
 * One task in the workspace home's list. Every task is shown the same way;
 * the one open on the page is marked as selected.
 */
function TaskRow(
  { task, now, selected, disabled, onOpen }: {
    task: TaskSummary;
    now: Date;
    selected: boolean;
    disabled: boolean;
    onOpen: () => void;
  },
) {
  const agent = task.harnessDisplayName ??
    (task.harness ? toolDisplayName(task.harness) : null);
  const created = taskCreatedLabel(task.createdAt, now);
  return (
    <button
      type="button"
      className={`start-task-row${selected ? " start-task-row-selected" : ""}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onOpen}
      title={task.title}
    >
      <span className="start-task-row-title">
        {task.title || "Untitled task"}
      </span>
      {created && <span className="start-task-row-created">{created}</span>}
      <span className="start-task-row-meta">
        {task.harness && <AgentBadge id={task.harness} />}
        <span>{agent ?? "No agent yet"}</span>
      </span>
      <span className="start-task-row-meta">
        <span>{taskStatusLabel(task, now)}</span>
      </span>
    </button>
  );
}

type SigninState =
  | { phase: "starting" }
  | { phase: "code"; userCode: string; url: string; progress: string }
  | { phase: "completed"; username: string }
  | { phase: "error"; message: string };

function progressText(event: SigninEvent): string | null {
  switch (event.kind) {
    case "polling":
      return "Waiting for you to approve…";
    case "securing_session":
      return "Securing your session…";
    default:
      return null;
  }
}

function SignInScreen({ status, client, onStatus }: ScreenProps) {
  const [state, setState] = useState<SigninState>({ phase: "starting" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Events and the reply are ignored once this screen is gone. Starting
    // again (a remount, or Try again) is safe: a second `start.signin` joins
    // the running sign-in and the server replays its device code.
    let active = true;
    let failed = false;
    setState({ phase: "starting" });
    client.stream<StartStatus>("start.signin", undefined, (raw) => {
      if (!active) return;
      const event = toSigninEvent(raw);
      if (!event) return;
      if (event.kind === "device_verification") {
        setState({
          phase: "code",
          userCode: event.userCode,
          url: event.verificationUriComplete ?? event.verificationUri,
          progress: "Waiting for you to approve…",
        });
      } else if (event.kind === "completed") {
        setState({ phase: "completed", username: event.username });
      } else if (event.kind === "error") {
        failed = true;
        setState({ phase: "error", message: event.message });
      } else {
        const progress = progressText(event);
        if (progress) {
          setState((prev) =>
            prev.phase === "code" ? { ...prev, progress } : prev
          );
        }
      }
    })
      .then((next) => {
        // An error event leaves the screen showing it, with Try again.
        if (active && !failed) onStatus(next);
      })
      .catch((err) => {
        if (!active) return;
        setState({
          phase: "error",
          message: errorMessage(err, "Sign-in failed."),
        });
      });
    return () => {
      active = false;
    };
  }, [attempt, client, onStatus]);

  // Before any workspace is chosen this is a new person's first screen.
  const welcome = !status.workspaceName;

  return (
    <div className="login-card start-card">
      {/* No client: sign-in comes first, so there's no Switch here. */}
      <StatusChips status={status} />
      {welcome
        ? (
          <>
            <h2 tabIndex={-1}>Welcome to Swamp</h2>
            <p className="start-lead">{SWAMP_ONE_LINER}</p>
            <p>First, sign in to your free Swamp Club account.</p>
          </>
        )
        : <h2 tabIndex={-1}>Swamp needs a free Swamp Club account.</h2>}
      {state.phase === "starting" && (
        <div className="login-waiting">
          <div className="login-spinner" />
          Starting sign-in…
        </div>
      )}
      {state.phase === "code" && (
        <>
          <p>
            Open Swamp Club, sign in or create an account, and confirm this
            code.
          </p>
          <div className="login-code-block">
            <div className="login-code-label">Confirmation code</div>
            <div className="login-code">{state.userCode}</div>
          </div>
          {isHttpsUrl(state.url)
            ? (
              <a
                className="start-primary start-full"
                href={state.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Swamp Club
              </a>
            )
            : state.url && (
              <p className="start-hint">
                Open <code>{state.url}</code> in your browser.
              </p>
            )}
          <div className="login-waiting">
            <div className="login-spinner" />
            {state.progress}
          </div>
        </>
      )}
      {state.phase === "completed" && (
        <div className="login-waiting">
          <div className="login-spinner" />
          Signed in as {state.username}. Carrying on…
        </div>
      )}
      {state.phase === "error" && (
        <>
          <ErrorBox message={state.message} />
          <button
            type="button"
            className="start-primary start-full"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}

function BlockedScreen({ status }: ScreenProps) {
  return (
    <div className="login-card start-card">
      <StatusChips status={status} />
      <h2 tabIndex={-1}>Swamp couldn't verify your account.</h2>
      {status.blockedReason && <p>{status.blockedReason}</p>}
      {status.apiKeyFromEnv && (
        <div className="start-warning">
          {withCode("Fix or unset `SWAMP_API_KEY`, then reload.")}
        </div>
      )}
    </div>
  );
}

function AgentScreen({ status, client, onStatus }: ScreenProps) {
  const {
    harnesses,
    error: listError,
    refresh: checkAgain,
  } = useHarnesses(client);
  const [selected, setSelected] = useState<string | null>(null);
  const [extras, setExtras] = useState<string[]>(() =>
    (status.tools ?? []).filter((id) => id !== status.harness?.id)
  );
  const [extrasOpen, setExtrasOpen] = useState(() =>
    showExtrasOpen(status.enrolledTools, extras)
  );
  const { busy, error, run } = useAction(onStatus);

  // The agent that opens is always set up; it is never an extra.
  useEffect(() => {
    if (selected !== null) {
      setExtras((prev) =>
        prev.includes(selected) ? prev.filter((id) => id !== selected) : prev
      );
    }
  }, [selected]);

  const taskHarnessId = status.harness?.id;
  const lastAgent = status.lastAgent;
  useEffect(() => {
    if (harnesses === null) return;
    const launchable = harnesses.filter(isLaunchable).map((h) => h.id);
    setSelected((prev) =>
      initialAgentPick(launchable, prev, taskHarnessId, lastAgent)
    );
  }, [harnesses, taskHarnessId, lastAgent]);

  const back = () => void run(() => client.request<StartStatus>("start.back"));
  const { available, unavailable } = splitHarnesses(harnesses ?? []);
  const noneLaunchable = harnesses !== null &&
    !available.some((h) => h.launchable);
  const launchable = available.filter((h) => h.launchable);
  const launchableCount = launchable.length;
  const solo = launchableCount === 1;
  const radio = useRadioGroup(selected, launchable.map((h) => h.id));
  const { heading, intro } = agentScreenHeading(
    launchableCount,
    launchable[0]?.displayName,
  );
  const selectedName = available.find((h) => h.id === selected)?.displayName;
  const enrolled = status.enrolledTools ?? [];
  const extraRows = [...available, ...unavailable].filter((h) =>
    h.id !== selected
  );
  const toggleExtra = (id: string) =>
    setExtras((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const extrasBody = selected !== null && (
    <>
      <ToolTickGrid
        rows={extraRows}
        enrolled={enrolled}
        checked={extras}
        disabled={busy}
        onToggle={toggleExtra}
      />
      <p className="start-hint">
        {withCode(
          "Each agent you select gets its instruction file and settings in " +
            "this workspace. Only " +
            `${selectedName ?? toolDisplayName(selected)} opens.`,
        )}
      </p>
      {unavailable.length > 0 && (
        <p className="start-hint">
          Swamp looks for each agent's command on your PATH.{" "}
          <button
            type="button"
            className="start-link"
            onClick={checkAgain}
          >
            Refresh agent list
          </button>
        </p>
      )}
    </>
  );

  return (
    <div className="login-card start-card">
      <StatusChips
        status={status}
        client={client}
        onStatus={onStatus}
        disabled={busy}
      />
      <h2 tabIndex={-1}>{heading}</h2>
      {harnesses !== null && !noneLaunchable && intro && (
        <p className="start-lead">{intro}</p>
      )}
      {status.task?.title && (
        <div className="start-task-strip">
          <span className="start-task-strip-label">Your task</span>
          <span className="start-task-strip-text">{status.task.title}</span>
        </div>
      )}
      <ErrorBox message={error ?? listError} />
      {harnesses === null && !listError && (
        <div className="login-waiting">
          <div className="login-spinner" />
          Looking for agents on this machine…
        </div>
      )}
      {noneLaunchable && (
        <>
          <p>
            Swamp didn't find a supported agent on this machine. Install one,
            then check again.
          </p>
          <ul className="start-install">
            <li>
              <a
                href="https://docs.anthropic.com/en/docs/claude-code"
                target="_blank"
                rel="noopener noreferrer"
              >
                Install Claude Code
              </a>
            </li>
            <li>
              <a
                href="https://github.com/openai/codex"
                target="_blank"
                rel="noopener noreferrer"
              >
                Install Codex
              </a>
            </li>
          </ul>
        </>
      )}
      {harnesses !== null && available.length > 0 && (
        <>
          <div
            className="start-harnesses"
            role={solo ? undefined : "radiogroup"}
            aria-label={solo ? undefined : "Agents on this machine"}
            onKeyDown={solo ? undefined : radio.onKeyDown}
          >
            {available.map((h) => (
              <HarnessCard
                key={h.id}
                harness={h}
                selected={selected === h.id}
                fixed={solo}
                tabIndex={radio.tabIndexFor(h.id)}
                onSelect={() => setSelected(h.id)}
              />
            ))}
          </div>
        </>
      )}
      {harnesses !== null && selected !== null && extraRows.length > 0 && (
        enrolled.length > 0
          ? (
            <fieldset className="start-extras">
              <legend>Also set up this workspace for</legend>
              {extrasBody}
            </fieldset>
          )
          : (
            <details
              className="start-extras start-extras-fold"
              open={extrasOpen}
              onToggle={(e) => setExtrasOpen(e.currentTarget.open)}
            >
              <summary>Set up more agents in this workspace</summary>
              {extrasBody}
            </details>
          )
      )}
      {noneLaunchable && unavailable.length > 0 && (
        <details className="start-others">
          <summary>
            {unavailable.length === 1
              ? "1 other supported agent isn't installed"
              : `${unavailable.length} other supported agents aren't installed`}
          </summary>
          <ul className="start-missing">
            {unavailable.map((h) => (
              <li key={h.id} className="start-missing-item">
                <span className="start-missing-name">{h.displayName}</span>
                <code className="start-missing-binary">{h.binary}</code>
              </li>
            ))}
          </ul>
          <p className="start-hint">
            Swamp looks for these commands on your PATH.{" "}
            <button
              type="button"
              className="start-link"
              onClick={checkAgain}
            >
              Refresh agent list
            </button>
          </p>
        </details>
      )}
      <div className="start-actions">
        <button
          type="button"
          className="start-secondary"
          onClick={back}
          disabled={busy}
        >
          Back
        </button>
        {noneLaunchable
          ? (
            <button
              type="button"
              className="start-primary"
              onClick={checkAgain}
            >
              Refresh agent list
            </button>
          )
          : (
            <button
              type="button"
              className="start-primary"
              disabled={busy || selected === null}
              onClick={() =>
                selected !== null &&
                void run(() =>
                  client.request<StartStatus>("start.harness.choose", {
                    id: selected,
                    tools: extraToolsToSend(extras, selected, enrolled),
                  })
                )}
            >
              {selectedName ? `Continue with ${selectedName}` : "Continue"}
            </button>
          )}
      </div>
    </div>
  );
}

/**
 * The "set this workspace up for" tick tiles: enrolled agents are ticked and
 * locked; the others say whether they are installed.
 */
function ToolTickGrid(
  { rows, enrolled, checked, disabled, onToggle }: {
    rows: readonly StartHarness[];
    enrolled: readonly string[];
    checked: readonly string[];
    disabled: boolean;
    onToggle: (id: string) => void;
  },
) {
  return (
    <ul className="start-extra-list">
      {rows.map((h) => {
        const isEnrolled = enrolled.includes(h.id);
        const ticked = isEnrolled || checked.includes(h.id);
        const note = isEnrolled
          ? "Already set up"
          : h.found
          ? "Installed"
          : "Not found on PATH";
        const hover = isEnrolled
          ? `${h.displayName} is already set up in this workspace`
          : h.found
          ? `Set up ${h.displayName} in this workspace too`
          : `Swamp looked for ${h.binary} on your PATH and didn't find it. Ticking it still adds ${h.displayName}'s instruction file and settings to this workspace.`;
        return (
          <li key={h.id}>
            <label
              className={`start-extra${
                isEnrolled ? " start-extra-enrolled" : ""
              }${ticked ? " start-extra-checked" : ""}${
                !h.found && !isEnrolled ? " start-extra-notfound" : ""
              }`}
              title={hover}
            >
              <input
                type="checkbox"
                aria-label={`${h.displayName}: ${note}`}
                checked={ticked}
                disabled={isEnrolled || disabled}
                onChange={() => onToggle(h.id)}
              />
              <span className="start-extra-text">
                <span className="start-extra-name">
                  <AgentBadge id={h.id} />
                  {h.displayName}
                </span>
                <span
                  className={`start-extra-note${
                    !h.found && !isEnrolled ? " start-extra-missing" : ""
                  }`}
                >
                  {note}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** One line on what each agent is, for people choosing between them. */
const HARNESS_BLURBS: Record<string, string> = {
  claude: "Anthropic's coding agent",
  codex: "OpenAI's coding agent",
  opencode: "Open-source coding agent",
  cursor: "Cursor's agent for the terminal",
  copilot: "GitHub Copilot in the terminal",
  kiro: "AWS's Kiro agent",
  amp: "Sourcegraph's coding agent",
  antigravity: "Google's Antigravity agent",
};

function trustTag(mode: string): string | null {
  switch (mode) {
    case "dialog":
      return "Asks you to trust the folder once";
    case "passed":
      return "Swamp answers its trust prompt for you";
    default:
      return null;
  }
}

function HarnessCard(
  { harness, selected, fixed = false, tabIndex, onSelect }: {
    harness: StartHarness;
    selected: boolean;
    /** Only one agent can open, so the card shows it without a choice. */
    fixed?: boolean;
    tabIndex: number;
    onSelect: () => void;
  },
) {
  const blurb = HARNESS_BLURBS[harness.id];
  const tag = harness.launchable ? trustTag(harness.trustMode) : null;
  const body = (
    <span className="start-agent-body">
      <AgentBadge id={harness.id} size="lg" />
      <span className="start-agent-head">
        <span className="start-harness-name">{harness.displayName}</span>
        {blurb && <span className="start-agent-blurb">{blurb}</span>}
      </span>
      {tag && <span className="start-agent-tag">{tag}</span>}
      {!harness.launchable && (
        <span className="start-harness-note">
          Installed, but Swamp can't start it with a task yet
        </span>
      )}
      {harness.binaryPath && (
        <span className="start-agent-path" title={harness.binaryPath}>
          {harness.binaryPath}
        </span>
      )}
    </span>
  );
  if (fixed) {
    return (
      <div
        className={`start-harness start-agent start-agent-fixed${
          selected ? " start-harness-selected" : ""
        }${harness.launchable ? "" : " start-agent-unavailable"}`}
      >
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabIndex}
      disabled={!harness.launchable}
      className={`start-harness start-agent${
        selected ? " start-harness-selected" : ""
      }`}
      onClick={onSelect}
    >
      <span className="start-radio" aria-hidden="true" />
      {body}
    </button>
  );
}

function launchStepLabel(step: LaunchStep, name: string): string {
  switch (step) {
    case "checking":
      return "Checking the workspace";
    case "enrolling":
      return `Setting up ${name} in the workspace`;
    case "brief_written":
      return "Writing the brief";
    case "window_opening":
      return "Opening a new terminal window";
    case "launched":
      return `${name} launched`;
  }
}

/**
 * Streams `start.launch` (or `start.resume`), tracking the furthest step and
 * any error. `launch` resolves true once the agent launched.
 */
function useLaunch(
  client: StartClient,
  onStatus: (s: StartStatus) => void,
  request: "start.launch" | "start.resume" = "start.launch",
) {
  const [reached, setReached] = useState<LaunchStep | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `trustConfirmed` carries the user's trust confirmation with a resume;
  // `start.launch` always does, since only the trust screen sends it.
  const launch = useCallback(async (trustConfirmed = false) => {
    setRunning(true);
    setReached(null);
    setError(null);
    let failed = false;
    try {
      const status = await client.stream<StartStatus>(
        request,
        request === "start.launch" || trustConfirmed
          ? { trustConfirmed: true }
          : undefined,
        (raw) => {
          const event = toLaunchEvent(raw);
          if (!event) return;
          if (event.kind === "error") {
            failed = true;
            setError(event.message);
          } else {
            setReached(event.kind);
          }
        },
      );
      onStatus(status);
    } catch (err) {
      failed = true;
      setError(errorMessage(err, "Launch failed."));
    } finally {
      setRunning(false);
      if (!failed) setReached(null);
    }
    return !failed;
  }, [client, onStatus, request]);

  return { launch, running, reached, error };
}

function LaunchChecklist(
  { reached, name, resume = false }: {
    reached: LaunchStep | null;
    name: string;
    /** Leaves out the brief step, which `start.resume` doesn't have. */
    resume?: boolean;
  },
) {
  const items = resume ? resumeChecklist(reached) : launchChecklist(reached);
  return (
    <ul className="start-checklist">
      {items.map(({ step, state }) => (
        <li key={step} className={`start-check start-check-${state}`}>
          <span className="start-check-mark" aria-hidden="true">
            {state === "done" ? "✓" : state === "active" ? "…" : ""}
          </span>
          {launchStepLabel(step, name)}
        </li>
      ))}
    </ul>
  );
}

function trustNote(mode: string, name: string): string {
  switch (mode) {
    case "dialog":
      return `When the new window opens, ${name} asks the same question. ` +
        "Choose 'Yes, I trust this folder'. The first option, 'No, exit', " +
        "closes it. It only asks once.";
    case "passed":
      return `Swamp passes your answer to ${name}, so it won't ask again.`;
    default:
      return `If ${name} asks whether to trust this folder, choose yes.`;
  }
}

const API_KEY_WARNING =
  "Your agent's terminal needs `SWAMP_API_KEY` too. Make sure your shell " +
  "profile sets it, or sign in with `swamp auth login`.";

function TrustScreen({ status, client, onStatus }: ScreenProps) {
  const name = status.harness?.displayName ?? "Your agent";
  const { busy, error: backError, run } = useAction(onStatus);
  const { launch, running, reached, error } = useLaunch(client, onStatus);
  const setup = setupSummary(
    status.enrolledTools,
    status.tools,
    status.harness?.id,
  );

  return (
    <div className="login-card start-card">
      <StatusChips
        status={status}
        client={client}
        onStatus={onStatus}
        disabled={busy || running}
      />
      <h2 tabIndex={-1}>{name} will work in your Swamp workspace.</h2>
      <div className="start-path">{status.workspacePath}</div>
      <ul className="start-facts">
        <li>{name} can read, edit and run files in this folder.</li>
        {setup && <li>{setup}</li>}
      </ul>
      <div className="start-note">
        {trustNote(status.harness?.trustMode ?? "unknown", name)}
      </div>
      {status.apiKeyFromEnv && (
        <div className="start-warning">{withCode(API_KEY_WARNING)}</div>
      )}
      {status.alsoOpenElsewhere && (
        <div className="start-warning">
          Another swamp start has this workspace open. Launching here opens a
          second {name} window in the same workspace.
        </div>
      )}
      <ErrorBox message={error ?? backError} />
      {(running || reached !== null) && (
        <LaunchChecklist reached={reached} name={name} />
      )}
      <div className="start-actions">
        <button
          type="button"
          className="start-secondary"
          disabled={busy || running}
          onClick={() =>
            void run(() => client.request<StartStatus>("start.back"))}
        >
          Back
        </button>
        <button
          type="button"
          className="start-primary"
          disabled={busy || running}
          onClick={() => void launch()}
        >
          {running ? "Launching…" : `Trust and launch ${name}`}
        </button>
      </div>
    </div>
  );
}

/** The launch command with a Copy button, for when no window opened. */
function CommandBlock(
  { client, command }: { client: StartClient; command: string },
) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  // "Copied" belongs to the command that was copied.
  useEffect(() => {
    setCopied("idle");
  }, [command]);

  const copy = async () => {
    const ok = await copyText(command);
    setCopied(ok ? "copied" : "failed");
    client.request("start.copied").catch(() => {
      // Only an acknowledgement; a failure changes nothing on the page.
    });
  };

  return (
    <div className="start-command">
      <pre className="start-command-text">{command}</pre>
      <button
        type="button"
        className="start-primary"
        onClick={() => void copy()}
      >
        {copied === "copied" ? "Copied" : "Copy"}
      </button>
      {copied === "failed" && (
        <p className="start-hint">
          Couldn't copy automatically. Select the command and copy it.
        </p>
      )}
    </div>
  );
}

/**
 * What to do when no window could be opened: open a terminal, paste the
 * command. The command box comes last, under the steps.
 */
function CopyCommandSteps(
  { client, command, name }: {
    client: StartClient;
    command: string;
    name: string;
  },
) {
  return (
    <div className="start-copy">
      <ol className="start-copy-steps">
        <li>Open a terminal.</li>
        <li>
          Paste this command and press Enter. {name}{" "}
          starts in your workspace and shows you the result there.
        </li>
      </ol>
      <CommandBlock client={client} command={command} />
    </div>
  );
}

function LaunchedScreen({ status, client, onStatus }: ScreenProps) {
  const name = status.harness?.displayName ?? "Your agent";
  const { busy, error: actionError, run } = useAction(onStatus);
  const { launch, running, reached, error } = useLaunch(client, onStatus);
  const [showCommand, setShowCommand] = useState(false);
  const opened = launchOpened(status.launch);
  const commandBlock = (
    <CopyCommandSteps
      client={client}
      command={status.launch?.command ?? ""}
      name={name}
    />
  );

  return (
    <div className="login-card start-card">
      <StatusChips
        status={status}
        client={client}
        onStatus={onStatus}
        disabled={busy || running}
      />
      <h2 tabIndex={-1}>
        {opened ? `${name} is on it.` : `${name} is ready to start.`}
      </h2>
      {!opened && status.task?.text && (
        <div className="start-task-hero">
          <div className="start-task-hero-label">Your task</div>
          <TaskPreview text={status.task.text} />
        </div>
      )}
      <ul className="start-done">
        <li>
          Signed in{status.username ? ` as ${status.username}` : ""}
        </li>
        <li>
          Workspace:{" "}
          <span className="start-inline-path">
            {status.workspacePath}
          </span>
        </li>
        {opened && (
          <li>
            {name} opened in a new terminal window with your task
            {status.task?.text && <TaskPreview text={status.task.text} />}
          </li>
        )}
      </ul>
      {opened
        ? (
          <>
            <p>
              Carry on in that window. {name}{" "}
              will show you the result there. You can close this tab.
            </p>
            {showCommand ? commandBlock : (
              <p className="start-hint">
                Window didn't appear?{" "}
                <button
                  type="button"
                  className="start-link"
                  onClick={() => setShowCommand(true)}
                >
                  Copy the command
                </button>
              </p>
            )}
          </>
        )
        : commandBlock}
      <ErrorBox message={error ?? actionError} />
      {running && <LaunchChecklist reached={reached} name={name} />}
      <WorkspaceAgentsPanel
        status={status}
        client={client}
        onStatus={onStatus}
        disabled={busy || running}
      />
      <div className="start-actions">
        <AllTasksLink
          count={status.tasks?.length}
          disabled={busy || running}
          onClick={() =>
            void run(() => client.request<StartStatus>("start.tasks.show"))}
        />
        <button
          type="button"
          className="start-secondary"
          disabled={busy || running}
          onClick={() =>
            void run(() => client.request<StartStatus>("start.new_task"))}
        >
          <span className="start-new-task-plus" aria-hidden="true">+</span>
          New task in this workspace
        </button>
        <button
          type="button"
          className="start-primary"
          disabled={busy || running}
          onClick={() => void launch()}
        >
          {running ? "Launching…" : "Launch again"}
        </button>
      </div>
    </div>
  );
}

/**
 * The workspace's home: every task, equally, and the open one's summary.
 * A launched task reopens its agent without pushing the task to it again;
 * one not launched yet carries on from its step.
 */
function HomeScreen({ status, client, onStatus }: ScreenProps) {
  const name = status.harness?.displayName ?? "Your agent";
  const { busy, error: actionError, run } = useAction(onStatus);
  const { launch, running, reached, error } = useLaunch(
    client,
    onStatus,
    "start.resume",
  );
  const [resumed, setResumed] = useState(false);
  const other = useOpenAgent(client, onStatus);
  // Which configured agents can launch here decides the agent toggle.
  const { harnesses, error: harnessError } = useHarnesses(client);
  const taskHarness = status.harness?.id ?? null;
  // An explicit pick from the toggle; null follows the task's own agent.
  const [choice, setChoice] = useState<string | null>(null);
  const task = splitTask(status.task?.text ?? "");
  const now = new Date();
  const launched = launchedLabel(status.launch?.at, now);
  const created = taskCreatedLabel(status.task?.createdAt, now);
  const tasks = status.tasks ?? [];
  const isLaunched = status.launch !== undefined;
  const openTask = (id: string) =>
    void run(() => client.request<StartStatus>("start.task.open", { id }));
  const contents = contentsLabel(status.contents);
  const enrolled = status.enrolledTools ?? [];

  const choices = launchChoices(harnesses ?? [], enrolled, taskHarness);
  const taskEntry = choices.find((c) => c.id === taskHarness);
  // Until the list is in (or if it couldn't be read) the task's agent is
  // taken to be launchable; the server checks again when it launches.
  const taskUsable = taskHarness === null || harnesses === null ||
    harnessError !== null ||
    (taskEntry !== undefined && isLaunchable(taskEntry));
  const taskNote = taskEntry && !taskEntry.found
    ? "Not found on PATH"
    : "Can't be started here";
  const pickedId = choice ?? (taskUsable ? taskHarness : null);
  const isTaskAgent = taskUsable && pickedId === taskHarness;
  const pickedOther = pickedId === taskHarness
    ? undefined
    : choices.find((c) => c.id === pickedId);
  const canLaunch = isTaskAgent || pickedOther !== undefined;
  const working = running || other.openingId !== null;
  const showToggle = choices.length > 1 || !taskUsable;
  const radio = useRadioGroup(
    pickedId,
    choices.filter((c) => c.id !== taskHarness || taskUsable).map((c) => c.id),
  );

  // Not yet trusted on this machine (an imported folder, or one from before
  // trust was recorded): the click confirms trust, shown above the button.
  const needsTrust = !status.trusted;
  const launchName = isTaskAgent ? name : pickedOther?.displayName ?? name;
  const launchAgent = async () => {
    setResumed(false);
    other.reset();
    if (isTaskAgent) {
      if (await launch(needsTrust)) setResumed(true);
    } else if (pickedOther) {
      await other.openAgent(
        pickedOther.id,
        pickedOther.displayName,
        needsTrust,
      );
    }
  };

  const guidance = isTaskAgent
    ? resumeGuidance(status.harness, status.task?.briefFile)
    : pickedOther
    ? `${pickedOther.displayName} opens in a new window in this workspace, without the task. It picks up its own earlier session here if it has one.`
    : choices.length > 1
    ? `Swamp can't start ${name} on this machine. Pick another agent this workspace is set up for; it opens without the task.`
    : `Swamp can't start ${name} on this machine. Install it, or set this workspace up for another agent under Configured agents.`;

  const stats = status.contents;
  return (
    <div className="login-card start-card start-resume">
      <StatusChips
        status={status}
        client={client}
        onStatus={onStatus}
        disabled={busy || working}
      />
      <div className="start-resume-head">
        <div className="start-hero">
          <div className="start-eyebrow">Welcome back</div>
          <h2 tabIndex={-1}>{status.workspaceName ?? "Your workspace"}</h2>
        </div>
        {stats && (
          <div className="start-stats" aria-label="Built so far">
            <div className="start-stat">
              <b>{stats.models}</b>
              <span>{behaviorNoun(stats.models)}</span>
            </div>
            <div className="start-stat">
              <b>{stats.workflows}</b>
              <span>{stats.workflows === 1 ? "workflow" : "workflows"}</span>
            </div>
          </div>
        )}
      </div>
      <div className="start-resume-layout">
        <section
          className="start-panel start-resume-main"
          aria-label="Task"
        >
          <div className="start-eyebrow start-eyebrow-quiet">Task</div>
          {task.title && (
            <div className="start-resume-task">
              <TaskPreview text={status.task?.text ?? task.title} />
            </div>
          )}
          {created && <div className="start-task-created">{created}</div>}
          {isLaunched
            ? (
              <div className="start-resume-meta">
                {taskHarness && <AgentBadge id={taskHarness} size="md" />}
                <span>
                  {launched ? `${name}, ${launched}` : name}
                  {!taskUsable && ` (${taskNote.toLowerCase()})`}
                </span>
              </div>
            )
            : (
              <>
                <p className="start-guidance">
                  Not launched yet. Carry on to pick its agent and launch it.
                </p>
                <ErrorBox message={actionError} />
                <div className="start-actions start-actions-start">
                  <button
                    type="button"
                    className="start-primary"
                    disabled={busy || status.taskId === undefined}
                    onClick={() => status.taskId && openTask(status.taskId)}
                  >
                    Continue
                  </button>
                </div>
              </>
            )}
          {isLaunched && showToggle && (
            <>
              <div className="start-field-label">
                Open an agent in this workspace
              </div>
              <div
                className="start-agent-toggle"
                role="radiogroup"
                aria-label="Agent to launch"
                onKeyDown={radio.onKeyDown}
              >
                {choices.map((c) => {
                  const own = c.id === taskHarness;
                  const unavailable = own && !taskUsable;
                  const checked = pickedId === c.id && !unavailable;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={radio.tabIndexFor(c.id)}
                      className={`start-agent-toggle-option${
                        checked ? " start-agent-toggle-selected" : ""
                      }`}
                      disabled={working || busy || unavailable}
                      onClick={() => {
                        setChoice(c.id);
                        setResumed(false);
                        other.reset();
                      }}
                    >
                      <AgentBadge id={c.id} size="md" />
                      <span className="start-agent-toggle-text">
                        <span className="start-agent-toggle-name">
                          {c.displayName}
                        </span>
                        <span className="start-agent-toggle-note">
                          {unavailable
                            ? taskNote
                            : own
                            ? (status.harness?.canResume
                              ? "Continues its conversation"
                              : "This task's agent")
                            : "Without the task"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {isLaunched && <p className="start-guidance">{guidance}</p>}
          {isLaunched && needsTrust && canLaunch && (
            <>
              <div className="start-path">{status.workspacePath}</div>
              <ul className="start-facts">
                <li>
                  {launchName} can read, edit and run files in this folder.
                </li>
              </ul>
            </>
          )}
          {isLaunched && (
            <ErrorBox message={error ?? actionError ?? other.error} />
          )}
          {other.openingId !== null && (
            <LaunchChecklist
              reached={other.reached}
              name={pickedOther?.displayName ?? "Your agent"}
              resume
            />
          )}
          {other.opened && (
            other.opened.opened
              ? (
                <div className="start-note" role="status">
                  {other.opened.name} opened in a new window.
                </div>
              )
              : (
                <CopyCommandSteps
                  client={client}
                  command={other.opened.command}
                  name={other.opened.name}
                />
              )
          )}
          {(running || reached !== null) && (
            <LaunchChecklist reached={reached} name={name} resume />
          )}
          {resumed && !running && (
            launchOpened(status.launch)
              ? (
                <div className="start-note" role="status">
                  {name} opened in a new window.
                </div>
              )
              : (
                <CopyCommandSteps
                  client={client}
                  command={status.launch?.command ?? ""}
                  name={name}
                />
              )
          )}
          {isLaunched && (
            <div className="start-actions start-actions-start">
              <button
                type="button"
                className="start-primary"
                disabled={busy || working || !canLaunch}
                onClick={() => void launchAgent()}
              >
                {resumeLaunchLabel(working, !needsTrust)}
              </button>
            </div>
          )}
        </section>
        <aside className="start-resume-aside" aria-label="This workspace">
          <div className="start-aside-head">
            <span className="start-aside-title">Tasks</span>
            <span className="start-hint">{tasks.length}</span>
          </div>
          <button
            type="button"
            className="start-new-task-action"
            disabled={busy || working}
            onClick={() =>
              void run(() => client.request<StartStatus>("start.new_task"))}
          >
            <span className="start-new-task-plus" aria-hidden="true">+</span>
            New task in this workspace
          </button>
          <div className="start-task-rows" aria-label="Tasks in this workspace">
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                now={now}
                selected={t.id === status.taskId}
                disabled={busy || working}
                onOpen={() => openTask(t.id)}
              />
            ))}
          </div>
          {contents && (
            <div className="start-aside-section">
              <div className="start-field-label">Built so far</div>
              <BuiltList contents={status.contents} fallback={contents} />
            </div>
          )}
          <WorkspaceAgentsPanel
            status={status}
            client={client}
            onStatus={onStatus}
            disabled={busy || working}
          />
        </aside>
      </div>
    </div>
  );
}

/** What the last `start.agent.open` ended with. */
interface AgentOpened {
  name: string;
  opened: boolean;
  command: string;
}

/**
 * Streams `start.agent.open`: opens an agent in the workspace without the
 * task, tracking its progress and whether a window opened.
 */
function useOpenAgent(
  client: StartClient,
  onStatus: (s: StartStatus) => void,
) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [reached, setReached] = useState<LaunchStep | null>(null);
  const [opened, setOpened] = useState<AgentOpened | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openAgent = async (
    id: string,
    displayName: string,
    trustConfirmed = false,
  ) => {
    setOpeningId(id);
    setReached(null);
    setOpened(null);
    setError(null);
    let failed = false;
    // Filled by the stream callback; an object so TS doesn't narrow it away.
    const result: { launched?: Extract<LaunchEvent, { kind: "launched" }> } =
      {};
    try {
      const next = await client.stream<StartStatus>(
        "start.agent.open",
        trustConfirmed ? { id, trustConfirmed: true } : { id },
        (raw) => {
          const event = toLaunchEvent(raw);
          if (!event) return;
          if (event.kind === "error") {
            failed = true;
            setError(event.message);
          } else {
            if (event.kind === "launched") result.launched = event;
            setReached(event.kind);
          }
        },
      );
      onStatus(next);
      if (!failed) {
        const done = result.launched;
        setOpened({
          name: displayName,
          opened: launchOpened(done),
          command: done?.command ?? "",
        });
      }
    } catch (err) {
      setError(errorMessage(err, `Couldn't open ${displayName}.`));
    } finally {
      setOpeningId(null);
    }
  };

  const reset = () => {
    setOpened(null);
    setError(null);
    setReached(null);
  };

  return { openAgent, openingId, reached, opened, error, reset };
}

/**
 * The quiet "Configured agents" panel on the resume, launched and tasks
 * screens: set the workspace up for more agents without starting a new
 * task. Which configured agent to launch is chosen on the home screen.
 */
function WorkspaceAgentsPanel(
  { status, client, onStatus, disabled = false }: ScreenProps & {
    /** True while the screen around the panel is busy. */
    disabled?: boolean;
  },
) {
  const [expanded, setExpanded] = useState(false);
  // Looked up each time the panel opens, so it reflects new installs.
  const { harnesses, error: listError } = useHarnesses(client, expanded);
  const [checked, setChecked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const enrolled = status.enrolledTools ?? [];

  const busy = disabled || saving;
  const { available, unavailable } = splitHarnesses(harnesses ?? []);
  const toAdd = toolsToAdd(checked, enrolled);

  const toggle = (id: string) => {
    setSaved(null);
    setSaveError(null);
    setChecked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const save = async () => {
    if (toAdd.length === 0) return;
    setSaving(true);
    setSaved(null);
    setSaveError(null);
    try {
      onStatus(
        await client.request<StartStatus>("start.tools.add", { tools: toAdd }),
      );
      setChecked([]);
      setSaved(`Set up for ${joinNames(toAdd.map(toolDisplayName))}.`);
    } catch (err) {
      setSaveError(errorMessage(err, "Couldn't set up those agents."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <details
      className="start-others start-agents-panel"
      open={expanded}
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
      <summary>{agentsToggleLabel(enrolled.length)}</summary>
      <ErrorBox message={listError} />
      {expanded && harnesses === null && !listError && (
        <div className="login-waiting">
          <div className="login-spinner" />
          Looking for agents on this machine…
        </div>
      )}
      {harnesses !== null && (
        <fieldset className="start-extras start-agents-section">
          <legend>Set up this workspace for</legend>
          <ToolTickGrid
            rows={[...available, ...unavailable]}
            enrolled={enrolled}
            checked={checked}
            disabled={busy}
            onToggle={toggle}
          />
          <ErrorBox message={saveError} />
          {saved && <div className="start-note" role="status">{saved}</div>}
          <div className="start-agents-save">
            <button
              type="button"
              className="start-secondary start-small"
              disabled={busy || toAdd.length === 0}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </fieldset>
      )}
    </details>
  );
}

/** Past this many characters a task is cut down in summaries. */
const TASK_PREVIEW_CHARS = 140;

/**
 * A task in a summary, however long it is: its first line, cut to two
 * lines, and the whole text behind "Show full task" in a box that scrolls
 * inside itself, so a pasted essay never stretches the page.
 */
function TaskPreview({ text }: { text: string }) {
  const task = splitTask(text);
  const long = task.rest.length > 0 ||
    task.title.length > TASK_PREVIEW_CHARS;
  return (
    <div className="start-task-preview">
      <div className="start-task-clamp">{task.title || text}</div>
      {long && (
        <details className="start-task-full">
          <summary>Show full task</summary>
          <div className="start-task-body" tabIndex={0}>{text}</div>
        </details>
      )}
    </div>
  );
}

/** The behaviors and workflows a workspace holds, by name, in a summary. */
function BuiltList(
  { contents, fallback }: {
    contents: StartStatus["contents"];
    fallback: string;
  },
) {
  const names = contentsNames(contents);
  if (!names || (names.models.length === 0 && names.workflows.length === 0)) {
    return <>{fallback}</>;
  }
  const group = (label: string, items: string[], more: number) =>
    items.length === 0 ? null : (
      <div className="start-built-group">
        <span className="start-built-label">{label}</span>
        <span className="start-built-items">
          {items.map((item) => (
            <code key={item} className="start-built-item">{item}</code>
          ))}
          {more > 0 && <span className="start-built-more">+{more} more</span>}
        </span>
      </div>
    );
  return (
    <div className="start-built">
      {group(BEHAVIORS_LABEL, names.models, names.moreModels)}
      {group("Workflows", names.workflows, names.moreWorkflows)}
    </div>
  );
}
