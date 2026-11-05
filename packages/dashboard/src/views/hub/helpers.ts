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

export interface HubEngine {
  id: string;
  state: string;
  ready: boolean;
  running: boolean;
  pid?: number;
  startedAt?: string;
  lastUsed?: string;
  sessions: number;
  pages: number;
  starts: number;
}

/** a running or recently ended `swamp serve` for a workspace */
export interface HubServe {
  /** set for serves the hub started, which the page can stop */
  id?: string;
  owner: "hub" | "other";
  state: string;
  pid?: number;
  port?: number;
  url?: string;
  authMode?: string;
  dashboard: boolean;
  startedAt?: string;
  exitCode?: number;
  reason?: string;
}

export interface HubWorkspace {
  name: string;
  path: string;
  trusted: boolean;
  temporary: boolean;
  missing: boolean;
  engine: HubEngine | null;
  serves: HubServe[];
}

export interface HubLease {
  id: string;
  client?: string;
  pid?: number;
  scope: "all" | "workspace";
  workspace?: string;
  path?: string;
  manage: boolean;
  pages: number;
  backend: boolean;
  createdAt: string;
  renewedAt: string;
  expiresAt?: string;
  self: boolean;
}

export interface HubInfo {
  pid?: number;
  port?: number;
  version?: string;
  gitSha?: string;
  engine?: string;
  engineVersion?: string;
  engineGitSha?: string;
  autoExit: boolean;
  startedAt?: string;
  exitWhenIdle?: string;
  leaseTtl?: string;
}

export interface HubOverview {
  hub: HubInfo;
  workspaces: HubWorkspace[];
  leases: HubLease[];
  log: { path: string; lines: string[] } | null;
  registryError?: string;
  servesError?: string;
}

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value !== null && typeof value === "object" ? value as Raw : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function parseEngine(value: unknown): HubEngine | null {
  if (value === null || typeof value !== "object") return null;
  const raw = record(value);
  const id = text(raw.id);
  if (id === undefined) return null;
  return {
    id,
    state: text(raw.state) ?? "stopped",
    ready: raw.ready === true,
    running: raw.running === true,
    pid: optionalNumber(raw.pid),
    startedAt: text(raw.startedAt),
    lastUsed: text(raw.lastUsed),
    sessions: count(raw.sessions),
    pages: count(raw.pages),
    starts: count(raw.starts),
  };
}

function parseServe(value: unknown): HubServe | null {
  const raw = record(value);
  const state = text(raw.state);
  if (state === undefined) return null;
  return {
    id: text(raw.id),
    owner: raw.owner === "hub" ? "hub" : "other",
    state,
    pid: optionalNumber(raw.pid),
    port: optionalNumber(raw.port),
    url: text(raw.url),
    authMode: text(raw.authMode),
    dashboard: raw.dashboard === true,
    startedAt: text(raw.startedAt),
    exitCode: typeof raw.exitCode === "number" ? raw.exitCode : undefined,
    reason: text(raw.reason),
  };
}

/** Reads `/api/local/hub`, dropping entries it can't use rather than failing. */
export function parseOverview(body: unknown): HubOverview {
  const raw = record(body);
  const hub = record(raw.hub);
  const info = record(hub.info);
  const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces : [];
  const leases = Array.isArray(raw.leases) ? raw.leases : [];
  const log = raw.log === null ? null : record(raw.log);
  return {
    hub: {
      pid: optionalNumber(info.pid),
      port: optionalNumber(info.port),
      version: text(info.version),
      gitSha: text(info.gitSha),
      engine: text(info.engine),
      engineVersion: text(info.engineVersion),
      engineGitSha: text(info.engineGitSha),
      autoExit: info.autoExit === true,
      startedAt: text(hub.startedAt),
      exitWhenIdle: text(hub.exitWhenIdle),
      leaseTtl: text(hub.leaseTtl),
    },
    workspaces: workspaces.map(record).filter((w) =>
      text(w.name) !== undefined && text(w.path) !== undefined
    ).map((w) => ({
      name: w.name as string,
      path: w.path as string,
      trusted: w.trusted === true,
      temporary: w.temporary === true,
      missing: w.missing === true,
      engine: parseEngine(w.engine),
      serves: Array.isArray(w.serves)
        ? w.serves.map(parseServe).filter((x): x is HubServe => x !== null)
        : [],
    })),
    leases: leases.map(record).filter((l) => text(l.id) !== undefined).map((
      l,
    ) => ({
      id: l.id as string,
      client: text(l.client),
      pid: optionalNumber(l.pid),
      scope: l.scope === "all" ? "all" : "workspace",
      workspace: text(l.workspace),
      path: text(l.path),
      manage: l.manage === true,
      pages: count(l.pages),
      backend: l.backend === true,
      createdAt: text(l.createdAt) ?? "",
      renewedAt: text(l.renewedAt) ?? "",
      expiresAt: text(l.expiresAt),
      self: l.self === true,
    })),
    log: log === null || text(log.path) === undefined ? null : {
      path: log.path as string,
      lines: Array.isArray(log.lines)
        ? log.lines.filter((line): line is string => typeof line === "string")
        : [],
    },
    registryError: text(raw.registryError),
    servesError: text(raw.servesError),
  };
}

const LIVE_SERVE_STATES = new Set(["starting", "running", "stopping"]);

export function serveIsLive(serve: HubServe): boolean {
  return LIVE_SERVE_STATES.has(serve.state);
}

const SERVE_TONES: Record<string, string> = {
  running: "active",
  starting: "running",
  stopping: "degraded",
  failed: "failed",
  exited: "idle",
};

export function serveStatus(serve: HubServe): EngineStatus {
  return { tone: SERVE_TONES[serve.state] ?? "idle", label: serve.state };
}

/** serve's own dashboard, when it serves one and has said where */
export function serveDashboardUrl(serve: HubServe): string | undefined {
  return serve.dashboard && serve.url !== undefined && serveIsLive(serve)
    ? `${serve.url}/dashboard`
    : undefined;
}

/** what logging in to serve's own dashboard takes, in its auth mode */
export function serveAuthNote(serve: HubServe): string | undefined {
  switch (serve.authMode) {
    case undefined:
      return undefined;
    case "none":
      return "no login";
    case "token":
      return "token login";
    case "oauth":
      return "swamp club login";
    default:
      return `${serve.authMode} login`;
  }
}

/** A pill tone (a `StatusPill` style) and the word it shows. */
export interface EngineStatus {
  tone: string;
  label: string;
}

export function engineStatus(engine: HubEngine | null): EngineStatus {
  if (engine === null) return { tone: "idle", label: "stopped" };
  switch (engine.state) {
    case "ready":
      return engine.running
        ? { tone: "active", label: "running" }
        : { tone: "idle", label: "stopped" };
    case "starting":
      return { tone: "running", label: "starting" };
    case "broken":
    case "cooldown":
      return { tone: "failed", label: engine.state };
    case "retiring":
    case "quiescing":
    case "draining":
      return { tone: "degraded", label: engine.state };
    default:
      return { tone: "idle", label: engine.state };
  }
}

const CLIENT_LABELS: Record<string, string> = {
  start: "swamp start",
  dashboard: "swamp dashboard",
  hub: "swamp hub open",
};

/** The command holding a lease, or what it can reach when it didn't say. */
export function sessionLabel(lease: HubLease): string {
  if (lease.client !== undefined && CLIENT_LABELS[lease.client]) {
    return CLIENT_LABELS[lease.client];
  }
  return lease.scope === "all" ? "every workspace" : "one workspace";
}

/** What a lease can open: every workspace, or the one it names. */
export function sessionScope(lease: HubLease): string {
  if (lease.scope === "all") {
    return lease.manage ? "all workspaces, manages the hub" : "all workspaces";
  }
  return lease.workspace ?? "one workspace";
}

/** "45s", "12m", "3h 5m", "2d 4h": the two largest units. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** Time since an ISO instant, or a dash when there is none. */
export function since(iso: string | undefined, now: number): string {
  if (iso === undefined) return "—";
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "—" : formatDuration(now - at);
}
