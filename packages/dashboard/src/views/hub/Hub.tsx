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
import { type ReactNode, useCallback, useEffect, useState } from "react";
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
  fetchServeLog,
  type OverviewResult,
  postAction,
  revokeLeasePath,
  START_DASHBOARD_PATH,
  START_SWAMP_SERVE_PATH,
  startDashboardBody,
  STOP_HUB_PATH,
  stopEnginePath,
  stopSwampServePath,
  TRUST_WORKSPACE_PATH,
} from "./client.ts";
import {
  engineStatus,
  type HubLease,
  type HubOverview,
  type HubWorkspace,
  serveAuthNote,
  serveDashboardUrl,
  serveIsLive,
  serveStatus,
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
function StartButton(
  { label, onStart }: { label: string; onStart: () => Promise<void> },
) {
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
      {busy ? "Starting…" : label}
    </button>
  );
}

/** loads a hub-started serve's log tail */
type LoadLog = (
  id: string,
) => Promise<{ lines: string[]; path: string } | { error: string }>;

function DashboardActions(
  { workspace, act }: { workspace: HubWorkspace; act: Act },
) {
  const engine = workspace.engine;
  if (engine !== null && engine.running) {
    return (
      <span className="hub-buttons">
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
          question={engine.pages > 0
            ? `Close ${engine.pages} open tab${engine.pages === 1 ? "" : "s"}?`
            : "Stop this dashboard?"}
          onConfirm={() => act(stopEnginePath(engine.id)).catch(() => {})}
        />
      </span>
    );
  }
  // A registered folder that is gone has nothing to serve.
  if (workspace.missing) return null;
  return (
    <StartButton
      label="Start"
      onStart={() =>
        act(
          START_DASHBOARD_PATH,
          startDashboardBody(
            workspace.name,
            workspace.temporary ? workspace.path : undefined,
          ),
        )}
    />
  );
}

function DashboardCell(
  { workspace, now, act }: { workspace: HubWorkspace; now: number; act: Act },
) {
  const status = engineStatus(workspace.engine);
  const engine = workspace.engine;
  const running = engine !== null && engine.running;
  return (
    <div className="hub-cell">
      <div className="hub-cell-head">
        <StatusPill status={status.tone} label={status.label} />
        <DashboardActions workspace={workspace} act={act} />
      </div>
      {running
        ? (
          <div className="hub-dim hub-detail">
            {engine.pid ? `pid ${engine.pid} · ` : ""}
            {engine.pages} tab{engine.pages === 1 ? "" : "s"} · up{" "}
            {since(engine.startedAt, now)}
          </div>
        )
        : engine?.lastUsed
        ? (
          <div className="hub-dim hub-detail">
            last used {since(engine.lastUsed, now)} ago
          </div>
        )
        : null}
    </div>
  );
}

function ServeLog({ id, loadLog }: { id: string; loadLog: LoadLog }) {
  const [log, setLog] = useState<
    { lines: string[]; path: string } | { error: string } | null
  >(null);
  useEffect(() => {
    let current = true;
    loadLog(id).then((result) => {
      if (current) setLog(result);
    }).catch(() => {});
    return () => {
      current = false;
    };
  }, [id, loadLog]);
  if (log === null) return <p className="hub-empty">Loading the log…</p>;
  if ("error" in log) return <p className="hub-empty">{log.error}</p>;
  return (
    <div>
      <code className="hub-dim hub-path">{log.path}</code>
      {log.lines.length === 0
        ? <p className="hub-empty">The log is empty.</p>
        : <pre className="hub-log">{log.lines.join("\n")}</pre>}
    </div>
  );
}

function SwampServeCell(
  { workspace, now, act, loadLog }: {
    workspace: HubWorkspace;
    now: number;
    act: Act;
    loadLog: LoadLog;
  },
) {
  const [logFor, setLogFor] = useState<string | null>(null);
  const live = workspace.serves.some(serveIsLive);
  // Only a registered workspace can start one; swamp serve always loads extensions.
  const startable = !live && !workspace.temporary && !workspace.missing;
  return (
    <div className="hub-cell">
      {workspace.serves.map((serve, index) => {
        const status = serveStatus(serve);
        const link = serveDashboardUrl(serve);
        const auth = serveAuthNote(serve);
        const key = serve.id ?? `pid-${serve.pid ?? index}`;
        return (
          <div key={key} className="hub-serve">
            <div className="hub-cell-head">
              <StatusPill status={status.tone} label={status.label} />
              <span className="hub-buttons">
                {serve.owner === "hub" && serve.id !== undefined &&
                    serveIsLive(serve) && serve.state !== "stopping"
                  ? (
                    <ConfirmButton
                      label="Stop serve"
                      question="Stop this swamp serve? Its runs drain first."
                      onConfirm={() =>
                        act(stopSwampServePath(serve.id!)).catch(() => {})}
                    />
                  )
                  : null}
                {serve.owner === "hub" && serve.id !== undefined
                  ? (
                    <button
                      type="button"
                      className="btn-sm"
                      onClick={() =>
                        setLogFor(logFor === serve.id ? null : serve.id!)}
                    >
                      {logFor === serve.id ? "Hide log" : "Log"}
                    </button>
                  )
                  : null}
              </span>
            </div>
            <div className="hub-dim hub-detail">
              {link
                ? (
                  <a href={link} target="_blank" rel="noreferrer">
                    {serve.url!.replace(/^https?:\/\//, "")}
                  </a>
                )
                : serve.port
                ? `port ${serve.port}`
                : null}
              {auth ? ` · ${auth}` : ""}
              {serve.pid ? ` · pid ${serve.pid}` : ""}
              {serve.startedAt && serveIsLive(serve)
                ? ` · up ${since(serve.startedAt, now)}`
                : ""}
              {serve.owner === "other" ? " · started elsewhere" : ""}
              {serve.reason ? ` · ${serve.reason}` : ""}
              {!serveIsLive(serve) && serve.exitCode !== undefined
                ? ` · exit ${serve.exitCode}`
                : ""}
            </div>
            {logFor !== null && logFor === serve.id
              ? <ServeLog id={serve.id} loadLog={loadLog} />
              : null}
          </div>
        );
      })}
      {startable
        ? (
          workspace.trusted
            ? (
              <StartButton
                label="Start serve"
                onStart={() =>
                  act(START_SWAMP_SERVE_PATH, { name: workspace.name })}
              />
            )
            : (
              <button
                type="button"
                className="btn-sm"
                disabled
                title="swamp serve loads this workspace's extensions: trust it first"
              >
                Start serve
              </button>
            )
        )
        : workspace.serves.length === 0
        ? <span className="hub-dim">—</span>
        : null}
    </div>
  );
}

function WorkspaceActions(
  { workspace, act }: { workspace: HubWorkspace; act: Act },
) {
  // Only a registered workspace records trust; a swamp dashboard folder already has it.
  const trustable = !workspace.trusted && !workspace.temporary &&
    !workspace.missing;
  if (!trustable) return null;
  return (
    <ConfirmButton
      label="Trust"
      question={`Trust ${workspace.name}? Its extensions run as you.`}
      onConfirm={() =>
        act(TRUST_WORKSPACE_PATH, { name: workspace.name }).catch(() => {})}
    />
  );
}

function WorkspacesTable(
  { workspaces, now, act, loadLog }: {
    workspaces: HubWorkspace[];
    now: number;
    act: Act;
    loadLog: LoadLog;
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
            <table className="data-table hub-workspaces">
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Dashboard</th>
                  <th>swamp serve</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {workspaces.map((w) => (
                  <tr
                    key={`${w.temporary ? "path" : "name"}:${w.name}:${w.path}`}
                  >
                    <td>
                      <div className="hub-workspace">
                        <strong>{w.name}</strong>
                        {workspaceKind(w)}
                      </div>
                      <div className="hub-dim hub-path">{w.path}</div>
                    </td>
                    <td>
                      <DashboardCell workspace={w} now={now} act={act} />
                    </td>
                    <td>
                      <SwampServeCell
                        workspace={w}
                        now={now}
                        act={act}
                        loadLog={loadLog}
                      />
                    </td>
                    <td className="hub-actions">
                      <WorkspaceActions workspace={w} act={act} />
                    </td>
                  </tr>
                ))}
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
  { overview, now, act, loadLog, actionError }: {
    overview: HubOverview;
    now: number;
    act: Act;
    loadLog: LoadLog;
    actionError: string | null;
  },
) {
  return (
    <>
      {actionError ? <Notice text={actionError} /> : null}
      {overview.registryError ? <Notice text={overview.registryError} /> : null}
      <HubCard overview={overview} now={now} act={act} />
      {overview.servesError ? <Notice text={overview.servesError} /> : null}
      <WorkspacesTable
        workspaces={overview.workspaces}
        now={now}
        act={act}
        loadLog={loadLog}
      />
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

  const loadLog = useCallback<LoadLog>(
    (id) =>
      token
        ? fetchServeLog(token, id)
        : Promise.resolve({ error: "No token." }),
    [token],
  );

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
            loadLog={loadLog}
            actionError={actionError}
          />
        )
        : <p className="hub-empty">Loading…</p>}
    </HubFrame>
  );
}
