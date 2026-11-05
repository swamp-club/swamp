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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { type ReactNode, useEffect, useState } from "react";
import { Logo } from "../../components/Logo.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { useDocumentTitle } from "../../hooks/useDocumentTitle.ts";
import {
  dashboardBaseFor,
  keepLocalToken,
  LOCAL_TOKEN_KEY,
} from "../../client/workspace_path.ts";
import { parseTokenFromHash } from "../start/helpers.ts";
import {
  fetchOverview,
  type OverviewResult,
  postAction,
  revokeLeasePath,
  START_SERVE_PATH,
  startServeBody,
  STOP_HUB_PATH,
  stopEnginePath,
  TRUST_WORKSPACE_PATH,
} from "./client.ts";
import {
  engineStatus,
  type HubLease,
  type HubOverview,
  type HubWorkspace,
  sessionLabel,
  sessionScope,
  since,
} from "./helpers.ts";

/** runs one hub action; resolves once the page has the result */
type Act = (path: string, body?: unknown) => Promise<void>;

const POLL_MS = 3_000;
/** A hidden tab still polls, inside the hub's one-minute lease TTL, to keep its access. */
const HIDDEN_POLL_MS = 20_000;
/** The start page's sessionStorage key, which workspace pages also read. */
const START_TOKEN_KEY = "swamp-start-token";

/** The fragment's token, else this tab's, else the last one any tab kept. */
function readHubToken(): { token: string | null; fromHash: boolean } {
  const fromHash = parseTokenFromHash(location.hash);
  if (fromHash) return { token: fromHash, fromHash: true };
  for (
    const [storage, key] of [
      [() => sessionStorage, START_TOKEN_KEY],
      [() => localStorage, LOCAL_TOKEN_KEY],
    ] as const
  ) {
    try {
      const stored = storage().getItem(key);
      if (stored) return { token: stored, fromHash: false };
    } catch {
      // Storage blocked: look at the next one.
    }
  }
  return { token: null, fromHash: false };
}

/** Renders text with `backtick` spans as inline code. */
function withCode(text: string): ReactNode[] {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? <code key={i}>{part}</code> : part
  );
}

function HubFrame({ children }: { children: ReactNode }) {
  return (
    <div className="hub-page">
      <header className="hub-header">
        <Logo size="sm" />
        <span className="hub-brand">Swamp hub</span>
      </header>
      <main className="hub-main">{children}</main>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div className="hub-panel hub-notice">
      <p>{withCode(text)}</p>
    </div>
  );
}

/** A destructive button that asks once inline before acting. */
function ConfirmButton(
  { label, question, onConfirm, disabled = false, title }: {
    label: string;
    question: string;
    onConfirm: () => void;
    disabled?: boolean;
    title?: string;
  },
) {
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <span className="hub-confirm">
        <span>{question}</span>
        <button
          type="button"
          className="btn-sm btn-reject"
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          Yes
        </button>
        <button
          type="button"
          className="btn-sm"
          onClick={() => setAsking(false)}
        >
          No
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="btn-sm btn-reject"
      disabled={disabled}
      title={title}
      onClick={() => setAsking(true)}
    >
      {label}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="hub-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function HubCard(
  { overview, now, act }: {
    overview: HubOverview;
    now: number;
    act: Act;
  },
) {
  const { hub } = overview;
  const others = overview.leases.filter((l) => !l.self).length;
  return (
    <section className="hub-panel">
      <div className="hub-panel-head">
        <h2>Hub</h2>
        <ConfirmButton
          label="Stop hub"
          question={others === 0
            ? "Stop the hub?"
            : `Stop the hub? This ends ${others} other session${
              others === 1 ? "" : "s"
            }.`}
          onConfirm={() => act(STOP_HUB_PATH).catch(() => {})}
          disabled={!hub.autoExit}
          title={hub.autoExit
            ? undefined
            : "This hub runs as a user service: stop it with swamp hub daemon disable"}
        />
      </div>
      <dl className="hub-fields">
        <Field label="Version">
          {hub.version ?? "—"}
          {hub.gitSha
            ? <span className="hub-dim">{hub.gitSha.slice(0, 9)}</span>
            : null}
        </Field>
        <Field label="Swamp">
          <code>{hub.engine ?? "—"}</code>
          {hub.engineVersion
            ? <span className="hub-dim">{hub.engineVersion}</span>
            : null}
        </Field>
        <Field label="Address">
          {hub.port ? `127.0.0.1:${hub.port}` : "—"}
          {hub.pid ? <span className="hub-dim">pid {hub.pid}</span> : null}
        </Field>
        <Field label="Up">{since(hub.startedAt, now)}</Field>
        <Field label="Stops when idle">
          {hub.autoExit
            ? `after ${
              hub.exitWhenIdle ?? "a while"
            } with no sessions or dashboards`
            : "never: runs as a user service"}
        </Field>
      </dl>
    </section>
  );
}

function workspaceKind(workspace: HubWorkspace): ReactNode {
  if (workspace.missing) {
    return <span className="hub-tag hub-tag-warn">folder gone</span>;
  }
  if (workspace.temporary) {
    return <span className="hub-tag">swamp dashboard</span>;
  }
  if (!workspace.trusted) return <span className="hub-tag">untrusted</span>;
  return null;
}

/** Starts a stopped dashboard; shows that it is starting until the overview catches up. */
function StartButton({ onStart }: { onStart: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn-sm btn-approve"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        onStart().finally(() => setBusy(false)).catch(() => {});
      }}
    >
      {busy ? "Starting…" : "Start"}
    </button>
  );
}

function ServeActions(
  { workspace, act }: { workspace: HubWorkspace; act: Act },
) {
  const serve = workspace.engine;
  if (serve !== null && serve.running) {
    return (
      <>
        {workspace.temporary || workspace.missing ? null : (
          <a
            className="btn-sm hub-open"
            href={dashboardBaseFor(workspace.name)}
          >
            Open
          </a>
        )}
        <ConfirmButton
          label="Stop"
          question={serve.pages > 0
            ? `Close ${serve.pages} open tab${serve.pages === 1 ? "" : "s"}?`
            : "Stop this dashboard?"}
          onConfirm={() => act(stopEnginePath(serve.id)).catch(() => {})}
        />
      </>
    );
  }
  // A registered folder that is gone has nothing to serve.
  if (workspace.missing) return null;
  return (
    <StartButton
      onStart={() =>
        act(
          START_SERVE_PATH,
          startServeBody(
            workspace.name,
            workspace.temporary ? workspace.path : undefined,
          ),
        )}
    />
  );
}

function WorkspaceActions(
  { workspace, act }: { workspace: HubWorkspace; act: Act },
) {
  // Only a registered workspace records trust; a swamp dashboard folder already has it.
  const trustable = !workspace.trusted && !workspace.temporary &&
    !workspace.missing;
  return (
    <span className="hub-buttons">
      {trustable
        ? (
          <ConfirmButton
            label="Trust"
            question={`Trust ${workspace.name}? Its extensions run as you.`}
            onConfirm={() =>
              act(TRUST_WORKSPACE_PATH, { name: workspace.name }).catch(
                () => {},
              )}
          />
        )
        : null}
      <ServeActions workspace={workspace} act={act} />
    </span>
  );
}

function WorkspacesTable(
  { workspaces, now, act }: {
    workspaces: HubWorkspace[];
    now: number;
    act: Act;
  },
) {
  return (
    <section className="hub-panel">
      <div className="hub-panel-head">
        <h2>Workspaces</h2>
      </div>
      {workspaces.length === 0
        ? (
          <p className="hub-empty">
            {withCode(
              "No workspaces yet. Register one with `swamp start`, or run `swamp dashboard` in a repo.",
            )}
          </p>
        )
        : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Dashboard</th>
                  <th>Tabs</th>
                  <th>Up</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {workspaces.map((w) => {
                  const status = engineStatus(w.engine);
                  const running = w.engine !== null && w.engine.running;
                  return (
                    <tr
                      key={`${
                        w.temporary ? "path" : "name"
                      }:${w.name}:${w.path}`}
                    >
                      <td>
                        <div className="hub-workspace">
                          <strong>{w.name}</strong>
                          {workspaceKind(w)}
                        </div>
                        <div className="hub-dim hub-path">{w.path}</div>
                      </td>
                      <td>
                        <StatusPill status={status.tone} label={status.label} />
                        {running && w.engine?.pid
                          ? <span className="hub-dim">pid {w.engine.pid}</span>
                          : null}
                      </td>
                      <td>{running ? w.engine!.pages : "—"}</td>
                      <td>{running ? since(w.engine!.startedAt, now) : "—"}</td>
                      <td>{w.engine ? since(w.engine.lastUsed, now) : "—"}</td>
                      <td className="hub-actions">
                        <WorkspaceActions workspace={w} act={act} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

function SessionsTable(
  { leases, now, act }: {
    leases: HubLease[];
    now: number;
    act: Act;
  },
) {
  return (
    <section className="hub-panel">
      <div className="hub-panel-head">
        <h2>Sessions</h2>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Command</th>
              <th>Reaches</th>
              <th>Tabs</th>
              <th>Started</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {leases.map((l) => (
              <tr key={l.id}>
                <td>
                  {sessionLabel(l)}
                  {l.pid ? <span className="hub-dim">pid {l.pid}</span> : null}
                </td>
                <td>
                  {sessionScope(l)}
                  {l.path
                    ? <div className="hub-dim hub-path">{l.path}</div>
                    : null}
                </td>
                <td>{l.pages}</td>
                <td>{since(l.createdAt || undefined, now)} ago</td>
                <td className="hub-actions">
                  {l.self
                    ? <span className="hub-dim">This page</span>
                    : (
                      <ConfirmButton
                        label="End session"
                        question={`End ${sessionLabel(l)}? Its tabs close.`}
                        onConfirm={() =>
                          act(revokeLeasePath(l.id)).catch(() => {})}
                      />
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LogPanel({ overview }: { overview: HubOverview }) {
  const { log } = overview;
  return (
    <section className="hub-panel">
      <div className="hub-panel-head">
        <h2>Log</h2>
        {log ? <code className="hub-dim">{log.path}</code> : null}
      </div>
      {log === null
        ? (
          <p className="hub-empty">
            {withCode(
              overview.hub.autoExit
                ? "This hub keeps no log file."
                : "This hub runs as a user service, so its log is in the system journal: `journalctl --user -u swamp-hub`.",
            )}
          </p>
        )
        : log.lines.length === 0
        ? <p className="hub-empty">The log is empty.</p>
        : <pre className="hub-log">{log.lines.join("\n")}</pre>}
    </section>
  );
}

/** The loaded overview; separate from {@link Hub} so it renders without a server. */
export function HubOverviewView(
  { overview, now, act, actionError }: {
    overview: HubOverview;
    now: number;
    act: Act;
    actionError: string | null;
  },
) {
  return (
    <>
      {actionError ? <Notice text={actionError} /> : null}
      {overview.registryError ? <Notice text={overview.registryError} /> : null}
      <HubCard overview={overview} now={now} act={act} />
      <WorkspacesTable workspaces={overview.workspaces} now={now} act={act} />
      <SessionsTable leases={overview.leases} now={now} act={act} />
      <LogPanel overview={overview} />
    </>
  );
}

/** What the page says instead of the overview. */
export function hubStateText(
  result: OverviewResult | null,
  stopped: boolean,
): string | null {
  if (stopped) {
    return "The swamp hub stopped. Run `swamp hub open` to start it again.";
  }
  if (result === null) return null;
  switch (result.kind) {
    case "ok":
      return null;
    case "unauthorized":
      return "This page's access has ended. Run `swamp hub open` to open it again.";
    case "forbidden":
      return "This page opened from `swamp start` or `swamp dashboard`, which can't manage the hub. Run `swamp hub open`.";
    case "unavailable":
      return "This server has no hub overview. It needs the swamp hub (`swampd`): run `swamp hub open`.";
    case "error":
      return result.message;
  }
}

export function Hub() {
  useDocumentTitle("swamp hub");
  const [{ token, fromHash }] = useState(readHubToken);
  const [result, setResult] = useState<OverviewResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [version, setVersion] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);

  // Keep the token for reloads and workspace pages, and take it out of the address bar.
  useEffect(() => {
    if (!token || !fromHash) return;
    keepLocalToken(token);
    history.replaceState(null, "", location.pathname + location.search);
  }, [token, fromHash]);

  useEffect(() => {
    if (!token || stopped) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await fetchOverview(token, controller.signal);
      setResult(next);
      setNow(Date.now());
      if (next.kind === "unauthorized" || next.kind === "forbidden") return;
      const visible = document.visibilityState === "visible";
      timer = setTimeout(
        () => tick().catch(() => {}),
        visible ? POLL_MS : HIDDEN_POLL_MS,
      );
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      tick().catch(() => {});
    };
    tick().catch(() => {});
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token, version, stopped]);

  const act: Act = async (path, body) => {
    if (!token) return;
    const error = await postAction(token, path, body);
    setActionError(error);
    if (error === null && path === STOP_HUB_PATH) setStopped(true);
    setVersion((v) => v + 1);
  };

  if (!token) {
    return (
      <HubFrame>
        <Notice text="This page opens from `swamp hub open`." />
      </HubFrame>
    );
  }
  const message = hubStateText(result, stopped);
  return (
    <HubFrame>
      {message !== null
        ? <Notice text={message} />
        : result?.kind === "ok"
        ? (
          <HubOverviewView
            overview={result.overview}
            now={now}
            act={act}
            actionError={actionError}
          />
        )
        : <p className="hub-empty">Loading…</p>}
    </HubFrame>
  );
}
