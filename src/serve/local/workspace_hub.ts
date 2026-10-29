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

/**
 * The local hub's workspace routing. One swamp process serves one
 * repo (its extension registries are bound to it at startup), so each
 * workspace's dashboard runs in a child `swamp dashboard --child` process.
 * The hub, which is the `swamp start` server, owns the browser's one origin
 * and forwards `/w/<workspace>/...` to that workspace's child.
 */

import { endOnAbort } from "../stream_abort.ts";
import { getLogger } from "@logtape/logtape";
import { basename } from "@std/path";
import { markErrorPaths } from "../../domain/errors.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import { timingSafeEqual } from "../../domain/crypto/timing_safe_equal.ts";
import { HUB_TOKEN_ENV, HUB_TOKEN_HEADER } from "./hub_token.ts";
import {
  actionCommand,
  actionErrorCode,
  type ActionFrame,
  attachedReply,
  type DelegatedAction,
  FORWARDED_READS,
  isDelegatedAction,
  notAvailableLocally,
} from "./local_actions.ts";

const logger = getLogger(["swamp", "dashboard", "hub"]);

/** How many of a child's last stderr lines explain a failed start. */
const STDERR_TAIL_LINES = 20;
/** The header the dashboard sends its local token in (HTTP requests). */
export const LOCAL_TOKEN_HEADER = "x-swamp-local-token";
/** How long a child may take to start listening before it is killed. */
const CHILD_START_TIMEOUT_MS = 60_000;
/** How long a stopping child gets after stdin closes, then after SIGTERM. */
const CHILD_STOP_GRACE_MS = 10_000;
const CHILD_KILL_GRACE_MS = 5_000;

/** A workspace the switcher can offer. */
export interface HubWorkspace {
  readonly name: string;
  readonly path: string;
}

/** A running child: its loopback port and the token it requires. */
export interface HubChild {
  readonly port: number;
  readonly token: string;
  /** Resolves when the child process exits. */
  readonly exited: Promise<void>;
  stop(): Promise<void>;
}

export interface WorkspaceHubDeps {
  /**
   * The credential every workspace route and the workspace list require:
   * the start server's one-time token, which the page holds. Offered as
   * the `bearer.<token>` WebSocket subprotocol or the
   * {@link LOCAL_TOKEN_HEADER} header.
   */
  token: string;
  /** The registered workspace's folder, or null when there is none. */
  resolveWorkspace(name: string): Promise<string | null>;
  listWorkspaces(): Promise<HubWorkspace[]>;
  spawnChild(repoDir: string): Promise<HubChild>;
  /**
   * False when the hub serves one fixed repo (`swamp dashboard` in a
   * folder): the page then offers no workspace switcher. Defaults to true.
   */
  switchable?: boolean;
  /**
   * How long a workspace's child stays up with no dashboard tab open
   * before it is stopped. Defaults to {@link DEFAULT_CHILD_IDLE_MS}.
   */
  idleMs?: number;
  /**
   * Runs the local dashboard's actions as CLI commands in a workspace's
   * folder (see `local_actions.ts`). Defaults to {@link SWAMP_CLI_ACTIONS}.
   */
  actions?: ActionRunner;
}

/** How the hub runs `swamp` for an action in a workspace's folder. */
export interface ActionRunner {
  /**
   * Runs a command to its end and returns what it printed. `signal` stops
   * it when the hub shuts down.
   */
  run(
    repoDir: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Starts a command that outlives the hub (a resumed run). Resolves the
   * exit code when it ends.
   */
  start(
    repoDir: string,
    args: readonly string[],
  ): { readonly pid: number; readonly exited: Promise<number> };
  /**
   * Opens the repo's run tracker for the length of one resume's wait:
   * `isRunning` is true once `runId` runs under process `pid`.
   */
  watchRuns(repoDir: string): {
    isRunning(runId: string, pid: number): boolean;
    close(): void;
  };
}

/** How long a resume may take to start its run before the page is told. */
const RESUME_START_WAIT_MS = 30_000;
const RESUME_START_POLL_MS = 200;

/** A child with no dashboard open stops after this long, unless busy. */
export const DEFAULT_CHILD_IDLE_MS = 10 * 60_000;

export interface WorkspaceHub {
  /**
   * Answers a hub route, or null when the request is not one. `track` is
   * told about each browser socket so the server stays up while it is open.
   */
  handle(
    req: Request,
    track: (socket: WebSocket) => void,
  ): Promise<Response | null>;
  shutdown(): Promise<void>;
}

const WORKSPACE_ROUTE = /^\/w\/([^/]+)(\/.*)?$/;

export function createWorkspaceHub(deps: WorkspaceHubDeps): WorkspaceHub {
  // One entry per workspace folder: its child, the dashboard sockets open
  // on it, and the timer that stops it once none are.
  interface Entry {
    readonly child: Promise<HubChild>;
    sockets: number;
    /** HTTP requests in flight (the health stream lasts while a tab does). */
    requests: number;
    idle?: ReturnType<typeof setTimeout>;
  }
  const entries = new Map<string, Entry>();
  // Exit watchers and idle checks, awaited on shutdown.
  const pending = new Set<Promise<unknown>>();
  const keep = (work: Promise<unknown>) => {
    pending.add(work);
    work.finally(() => pending.delete(work)).catch(() => {});
  };
  const idleMs = deps.idleMs ?? DEFAULT_CHILD_IDLE_MS;
  const hubSignal = new AbortController();
  let stopping = false;

  const forget = (path: string, entry: Entry) => {
    clearTimeout(entry.idle);
    if (entries.get(path) === entry) entries.delete(path);
  };

  /** Arms (or re-arms) the idle stop, unless a tab is open. */
  const armIdle = (path: string, entry: Entry) => {
    clearTimeout(entry.idle);
    entry.idle = undefined;
    if (stopping || entry.sockets > 0 || entry.requests > 0) return;
    entry.idle = setTimeout(() => keep(stopIfIdle(path, entry)), idleMs);
  };

  /** True while the child runs something it started (it would die with it). */
  const childBusy = async (child: HubChild): Promise<boolean> => {
    try {
      const res = await fetch(`http://127.0.0.1:${child.port}/local/busy`, {
        headers: { [HUB_TOKEN_HEADER]: child.token },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return false;
      }
      return (await res.json() as { busy?: unknown }).busy === true;
    } catch {
      return false;
    }
  };

  const stopIfIdle = async (path: string, entry: Entry) => {
    entry.idle = undefined;
    if (
      stopping || entries.get(path) !== entry || entry.sockets > 0 ||
      entry.requests > 0
    ) return;
    let child: HubChild;
    try {
      child = await entry.child;
    } catch {
      return;
    }
    if (await childBusy(child)) {
      armIdle(path, entry);
      return;
    }
    // A tab may have opened while the child was asked.
    if (
      stopping || entries.get(path) !== entry || entry.sockets > 0 ||
      entry.requests > 0
    ) return;
    forget(path, entry);
    await child.stop();
  };

  const entryFor = (path: string): Entry => {
    let entry = entries.get(path);
    if (!entry) {
      const created: Entry = {
        child: deps.spawnChild(path),
        sockets: 0,
        requests: 0,
      };
      entry = created;
      entries.set(path, created);
      // A child that fails to start or exits is started again on next use.
      keep(created.child.then(
        (c) => c.exited.then(() => forget(path, created)),
        () => forget(path, created),
      ));
    }
    return entry;
  };

  const actions = deps.actions ?? SWAMP_CLI_ACTIONS;

  /** Runs one action as its CLI command and replies as serve would. */
  const runAction = async (
    repoDir: string,
    type: DelegatedAction,
    id: string,
    payload: unknown,
    reply: (frame: ActionFrame) => void,
  ) => {
    const fail = (message: string) =>
      reply({
        type: "error",
        id,
        error: { code: actionErrorCode(type), message },
      });
    const command = actionCommand(type, payload);
    if (command.kind === "invalid") return fail(command.message);
    try {
      if (!command.detached) {
        reply(
          attachedReply(
            type,
            id,
            await actions.run(repoDir, command.args, hubSignal.signal),
          ),
        );
        return;
      }
      // The tracker opens before the resume starts: a tracker that can't
      // be read fails the action with nothing started. Once the resume has
      // started, nothing may report it as failed, or a retry would resume
      // the same run twice.
      const runs = actions.watchRuns(repoDir);
      const closeRuns = () => {
        try {
          runs.close();
        } catch {
          // Closing a tracker that failed: nothing to release.
        }
      };
      let started: { readonly pid: number; readonly exited: Promise<number> };
      try {
        started = actions.start(repoDir, command.args);
      } catch (error) {
        closeRuns();
        throw error;
      }
      let exitCode: number | null = null;
      const exited = started.exited.then((code) => {
        exitCode = code;
        return code;
      });
      // A tracker read that fails after the start counts as running.
      const running = () => {
        try {
          return runs.isRunning(command.runId, started.pid);
        } catch {
          return true;
        }
      };
      const deadline = Date.now() + RESUME_START_WAIT_MS;
      try {
        while (
          !stopping && exitCode === null && Date.now() < deadline &&
          !running()
        ) {
          await Promise.race([
            exited,
            new Promise((r) => setTimeout(r, RESUME_START_POLL_MS)),
          ]);
        }
      } finally {
        closeRuns();
      }
      if (exitCode !== null && exitCode !== 0) {
        return fail(
          `The resume stopped before its run started (exit ${exitCode}). ` +
            `Run \`swamp ${command.args.slice(0, -1).join(" ")}\` in this ` +
            "repo to see why.",
        );
      }
      // Started, already finished, or still starting after the wait (a
      // resume waiting on a lock, say): the run is under way either way,
      // so the page detaches on this event.
      reply({ type: "event", id, payload: { runId: command.runId } });
      // The run is the resume's own now: the hub never waits for it (a
      // shutdown must not), and says `done` only if it ends meanwhile.
      exited.then(() => reply({ type: "done", id })).catch(() => {});
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  };

  const forwardHttp = async (
    req: Request,
    child: HubChild,
    path: string,
    search: string,
    done: () => void,
  ): Promise<Response> => {
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("origin");
    headers.delete(LOCAL_TOKEN_HEADER);
    headers.set(HUB_TOKEN_HEADER, child.token);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    // Not the request's signal: a streamed answer (the health SSE) ends
    // when the browser cancels the body, which cancels the upstream read.
    // The hub's own signal ends every forwarded stream when it shuts down,
    // so a tab left open never holds the server's shutdown up.
    let upstream: Response;
    try {
      upstream = await fetch(
        `http://127.0.0.1:${child.port}${path}${search}`,
        {
          method: req.method,
          headers,
          body: hasBody ? req.body : undefined,
          redirect: "manual",
          signal: hubSignal.signal,
        },
      );
    } catch {
      // The child went away between being found and being asked.
      done();
      return new Response("The workspace's dashboard could not be reached.", {
        status: 502,
      });
    }
    if (!upstream.body) {
      done();
      return new Response(null, {
        status: upstream.status,
        headers: upstream.headers,
      });
    }
    return new Response(endOnAbort(upstream.body, hubSignal.signal, done), {
      status: upstream.status,
      headers: upstream.headers,
    });
  };

  const forwardSocket = (
    req: Request,
    child: HubChild,
    path: string,
    search: string,
    track: (socket: WebSocket) => void,
    onClose: () => void,
    repoDir: string,
    protocol: string | undefined,
  ): Response => {
    const { socket, response } = Deno.upgradeWebSocket(
      req,
      protocol ? { protocol } : {},
    );
    socket.addEventListener("close", onClose);
    const upstream = new WebSocket(
      `ws://127.0.0.1:${child.port}${path}${search}`,
      [`bearer.${child.token}`],
    );
    socket.binaryType = "arraybuffer";
    upstream.binaryType = "arraybuffer";
    const toUpstream: Array<string | ArrayBuffer> = [];
    const toBrowser: Array<string | ArrayBuffer> = [];
    // A script may only close with 1000 or 3000–4999; anything else the
    // other side sent (1001 going away, 1006 dropped) passes on as 1000.
    const sendable = (code: number) =>
      code >= 3000 && code <= 4999 ? code : 1000;
    const closeQuietly = (ws: WebSocket, code: number, reason: string) => {
      if (ws.readyState > WebSocket.OPEN) return;
      try {
        ws.close(sendable(code), reason);
      } catch {
        // Already closing.
      }
    };
    socket.onopen = () => {
      for (const m of toBrowser.splice(0)) socket.send(m);
    };
    upstream.onopen = () => {
      for (const m of toUpstream.splice(0)) upstream.send(m);
    };
    // Reads forwarded to the child: only their ids may be cancelled there.
    // Any other `cancel` stays in the hub: one naming a run id would cancel
    // that run, and one naming an action is the page detaching from it.
    const forwarded = new Set<string>();
    const reply = (frame: ActionFrame) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    };
    const toChild = (data: string) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else toUpstream.push(data);
    };
    // The child is read-only and runs with no auth: it gets only the reads
    // the dashboard makes. Actions run as CLI commands; anything else is
    // refused, and frames that aren't requests are dropped.
    socket.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const frame = parseFrame(e.data);
      if (!frame) return;
      if (isDelegatedAction(frame.type)) {
        keep(runAction(repoDir, frame.type, frame.id, frame.payload, reply));
        return;
      }
      if (frame.type === "cancel") {
        if (forwarded.has(frame.id)) toChild(e.data);
        return;
      }
      if (FORWARDED_READS.has(frame.type)) {
        forwarded.add(frame.id);
        toChild(e.data);
        return;
      }
      reply(notAvailableLocally(frame.id, frame.type));
    };
    upstream.onmessage = (e) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(e.data);
      else toBrowser.push(e.data);
    };
    socket.onclose = (e) => closeQuietly(upstream, e.code, e.reason);
    upstream.onclose = (e) => closeQuietly(socket, e.code, e.reason);
    upstream.onerror = () => closeQuietly(socket, 1000, "workspace gone");
    track(socket);
    return response;
  };

  return {
    async handle(req, track) {
      const url = new URL(req.url);
      const isHubRoute = url.pathname === "/api/local/workspaces" ||
        WORKSPACE_ROUTE.test(url.pathname);
      if (!isHubRoute) return null;
      // The page's token, checked before anything starts or is listed.
      const offered = offeredLocalToken(req);
      if (offered === null || !timingSafeEqual(offered.token, deps.token)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (req.method === "GET" && url.pathname === "/api/local/workspaces") {
        const workspaces = await deps.listWorkspaces();
        return Response.json({
          workspaces,
          switchable: deps.switchable ?? true,
        });
      }
      const match = WORKSPACE_ROUTE.exec(url.pathname);
      if (!match) return null;
      if (stopping) return new Response("Stopping", { status: 503 });
      let name: string;
      try {
        name = decodeURIComponent(match[1]);
      } catch {
        return new Response("Not found", { status: 404 });
      }
      const path = match[2] ?? "/";
      const repoDir = await deps.resolveWorkspace(name);
      // Shutdown may have begun during the lookup: start nothing after it.
      if (stopping) return new Response("Stopping", { status: 503 });
      if (repoDir === null) {
        return new Response(`No workspace named ${name}`, { status: 404 });
      }
      const isUpgrade = req.headers.get("upgrade")?.toLowerCase() ===
        "websocket";
      if (isUpgrade) {
        // The dashboard has no login, so only this server's own pages may
        // open it: an exact origin, port included, not any localhost page.
        // The start server has already checked Host is its own authority.
        const origin = req.headers.get("origin");
        if (origin !== null && origin !== `http://${req.headers.get("host")}`) {
          return new Response("Forbidden origin", { status: 403 });
        }
      }
      const entry = entryFor(repoDir);
      let child: HubChild;
      try {
        child = await entry.child;
      } catch (error) {
        logger.warn`Workspace ${name} could not start: ${
          error instanceof Error ? error.message : String(error)
        }`;
        return new Response(
          `The dashboard for ${name} could not start.`,
          { status: 502 },
        );
      }
      if (!isUpgrade) {
        entry.requests++;
        clearTimeout(entry.idle);
        let finished = false;
        return await forwardHttp(req, child, path, url.search, () => {
          if (finished) return;
          finished = true;
          entry.requests--;
          armIdle(repoDir, entry);
        });
      }
      let response: Response;
      try {
        response = forwardSocket(
          req,
          child,
          path,
          url.search,
          track,
          () => {
            entry.sockets--;
            armIdle(repoDir, entry);
          },
          repoDir,
          offered.viaProtocol ? `bearer.${deps.token}` : undefined,
        );
      } catch {
        // A malformed upgrade: nothing was opened, so nothing is counted.
        armIdle(repoDir, entry);
        return new Response("Malformed WebSocket upgrade", { status: 400 });
      }
      entry.sockets++;
      clearTimeout(entry.idle);
      return response;
    },
    async shutdown() {
      stopping = true;
      hubSignal.abort();
      const all = [...entries.values()];
      for (const entry of all) clearTimeout(entry.idle);
      const started = await Promise.allSettled(all.map((e) => e.child));
      await Promise.all(
        started.flatMap((r) =>
          r.status === "fulfilled" ? [r.value.stop()] : []
        ),
      );
      await Promise.allSettled([...pending]);
      entries.clear();
    },
  };
}

/**
 * Starts `swamp dashboard --child` for a repo. The child prints
 * `{"port":N}` on stdout once it listens, and stops when its stdin closes,
 * so it never outlives the hub.
 */
export async function spawnDashboardChild(repoDir: string): Promise<HubChild> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const cmd = swampInvocation(["dashboard", "--child", "--repo-dir", repoDir]);
  const process = new Deno.Command(cmd.execPath, {
    args: cmd.args,
    stdin: "piped",
    stdout: "piped",
    // A child's output never reaches the terminal running the hub: one
    // workspace's warnings would repeat once per open workspace. Its last
    // lines are kept to explain a child that fails to start.
    stderr: "piped",
    env: childEnv(token),
    clearEnv: true,
  }).spawn();
  const stdin = process.stdin.getWriter();
  const status = process.status;
  const stderrTail: string[] = [];
  const stderrDrained = (async () => {
    const reader = process.stderr.pipeThrough(new TextDecoderStream())
      .getReader();
    let partial = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (partial + value).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    }
  })();

  const lines = process.stdout
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let buffered = "";
  let port: number | null = null;
  const failed = async (why: string) => {
    await stdin.close().catch(() => {});
    await Promise.all([status, stderrDrained]);
    const said = stderrTail.join("\n");
    return markErrorPaths(
      new Error(
        `swamp dashboard ${why} (${repoDir})` + (said ? `:\n${said}` : ""),
      ),
      [repoDir],
    );
  };
  // A child stalled before it listens (an unreachable datastore, a hung
  // mount) is killed rather than leaving its workspace's requests pending.
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    startTimer = setTimeout(() => resolve("timeout"), CHILD_START_TIMEOUT_MS);
  });
  while (port === null) {
    const next = await Promise.race([lines.read(), timedOut]);
    if (next === "timeout") {
      killQuietly(process, "SIGKILL");
      await lines.cancel().catch(() => {});
      throw await failed(
        `did not start listening within ${CHILD_START_TIMEOUT_MS / 1000}s`,
      );
    }
    const { value, done } = next;
    if (done) {
      clearTimeout(startTimer);
      throw await failed("exited before listening");
    }
    buffered += value;
    let newline: number;
    while (port === null && (newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      try {
        const parsed = JSON.parse(line) as { port?: unknown };
        if (typeof parsed.port === "number") port = parsed.port;
      } catch {
        // Not the port line.
      }
    }
  }
  clearTimeout(startTimer);
  // Keep draining stdout so the child never blocks on a full pipe.
  const drained = (async () => {
    while (!(await lines.read()).done) { /* discard */ }
  })();
  const exited = status.then(() => {});
  return {
    port,
    token,
    exited,
    async stop() {
      try {
        await stdin.close();
      } catch {
        // Already closed.
      }
      // Closing stdin asks it to stop; one that doesn't is terminated,
      // then killed, so a stuck child never holds the hub up.
      if (!await settlesWithin(status, CHILD_STOP_GRACE_MS)) {
        killQuietly(process, "SIGTERM");
        if (!await settlesWithin(status, CHILD_KILL_GRACE_MS)) {
          killQuietly(process, "SIGKILL");
        }
      }
      await Promise.all([status, drained, stderrDrained]);
    },
  };
}

/** A protocol request frame the page sent, or null for anything else. */
function parseFrame(
  text: string,
): { type: string; id: string; payload?: unknown } | null {
  try {
    const frame = JSON.parse(text) as Record<string, unknown>;
    return typeof frame?.type === "string" && typeof frame.id === "string"
      ? { type: frame.type, id: frame.id, payload: frame.payload }
      : null;
  } catch {
    return null;
  }
}

/** The command line that runs this swamp: the binary, or deno and swamp. */
function swampInvocation(args: readonly string[]): {
  execPath: string;
  args: string[];
} {
  const execPath = Deno.execPath();
  // From source, Deno.execPath() is deno and Deno.mainModule is swamp.
  const runningFromSource = /^deno(\.exe)?$/i.test(basename(execPath));
  return {
    execPath,
    // From source, as the `dev` task runs it.
    args: runningFromSource
      ? ["run", "-A", "--unstable-bundle", Deno.mainModule, ...args]
      : [...args],
  };
}

/**
 * The hub's environment for an action, without the variables that would
 * send it to a `swamp serve` (`--server`'s environment fallbacks): the
 * dashboard shows the local repo, so its actions act on it. A repo whose
 * marker names a server still sends them there, as the CLI does in it.
 */
export function actionEnv(): Record<string, string> {
  const env = Deno.env.toObject();
  delete env.SWAMP_SERVE_URL;
  delete env.SWAMP_SERVER_URL;
  return env;
}

/**
 * A workspace child's environment: the hub's, without the serve URLs (with
 * either set, the child would start as a thin client and not open its
 * repo's local extensions), plus its token.
 */
export function childEnv(token: string): Record<string, string> {
  return { ...actionEnv(), [HUB_TOKEN_ENV]: token };
}

/** Runs actions with this swamp's own CLI, against the workspace's folder. */
export const SWAMP_CLI_ACTIONS: ActionRunner = {
  async run(repoDir, args, signal) {
    const cmd = swampInvocation([...args, "--repo-dir", repoDir]);
    const out = await new Deno.Command(cmd.execPath, {
      args: cmd.args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: actionEnv(),
      clearEnv: true,
      ...(signal ? { signal } : {}),
    }).output();
    const decoder = new TextDecoder();
    return {
      code: out.code,
      stdout: decoder.decode(out.stdout),
      stderr: decoder.decode(out.stderr),
    };
  },
  start(repoDir, args) {
    const cmd = swampInvocation([...args, "--repo-dir", repoDir]);
    // Its own process group and no pipes: the run outlives the dashboard,
    // Ctrl-C in its terminal included, and never writes to a closed pipe.
    const process = new Deno.Command(cmd.execPath, {
      args: cmd.args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
      env: actionEnv(),
      clearEnv: true,
      detached: true,
    }).spawn();
    process.unref();
    return { pid: process.pid, exited: process.status.then((s) => s.code) };
  },
  watchRuns(repoDir) {
    const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    return {
      isRunning(runId, pid) {
        const run = tracker.findById(runId);
        return run !== null && run.status === "running" && run.pid === pid;
      },
      close: () => tracker.close(),
    };
  },
};

/**
 * The local token a request offers: the `bearer.<token>` subprotocol (the
 * page's WebSocket) or the {@link LOCAL_TOKEN_HEADER} header (its fetches).
 */
function offeredLocalToken(
  req: Request,
): { token: string; viaProtocol: boolean } | null {
  const header = req.headers.get(LOCAL_TOKEN_HEADER);
  if (header) return { token: header, viaProtocol: false };
  const protocols = req.headers.get("sec-websocket-protocol") ?? "";
  for (const p of protocols.split(",")) {
    const trimmed = p.trim();
    if (trimmed.startsWith("bearer.")) {
      return { token: trimmed.slice("bearer.".length), viaProtocol: true };
    }
  }
  return null;
}

/** True if `promise` settles within `ms`. */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Signals a child that may already have exited. */
function killQuietly(process: Deno.ChildProcess, signal: Deno.Signal): void {
  try {
    process.kill(signal);
  } catch {
    // Already exited.
  }
}
