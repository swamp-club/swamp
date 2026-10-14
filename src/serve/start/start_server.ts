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

import { z } from "zod";
import type { LibSwampContext } from "../../libswamp/context.ts";
import {
  resolveStartWorkspacePath,
  startAddTools,
  startBack,
  startCheckFolder,
  startCheckWorkspaceLocation,
  startChooseHarness,
  type StartDeps,
  startImportWorkspace,
  startLaunch,
  type StartLaunchEvent,
  startListHarnesses,
  startListTasks,
  startListWorkspaces,
  startOpenAgent,
  startOpenWorkspace,
  startPickFolder,
  startResume,
  startSaveTask,
  startSignIn,
  type StartSignInEvent,
  type StartStatus,
  startStatus,
  type StartStatusEvent,
  type StartWorkspaceLocationInput,
} from "../../libswamp/start/start.ts";
import { MAX_WORKSPACE_PARENT_LENGTH } from "../../libswamp/workspace/workspace_store.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { findHarness } from "../../domain/start/harness.ts";
import { timingSafeEqual } from "../../domain/crypto/timing_safe_equal.ts";
import { validateWebSocketOrigin } from "../origin.ts";
import { serveDashboardRoute } from "../dashboard_assets.ts";
import type { WorkspaceHub } from "../local/workspace_hub.ts";
import { START_PING_TOKEN_HEADER } from "../../infrastructure/process/start_instance_probe.ts";

/** How long each end condition waits. Injected so tests can shorten them. */
export interface StartServerTimeouts {
  /** After launch, with no page connected (allows reloads). */
  readonly afterLaunchIdleMs: number;
  /** Before launch, with no page connected. */
  readonly beforeLaunchIdleMs: number;
  /** After a copy-command fallback, while the page is still connected. */
  readonly copyFallbackMs: number;
}

export const DEFAULT_START_SERVER_TIMEOUTS: StartServerTimeouts = {
  afterLaunchIdleMs: 60_000,
  beforeLaunchIdleMs: 10 * 60_000,
  copyFallbackMs: 30 * 60_000,
};

/** Why the start server stopped on its own. */
export type StartServerEnd =
  | { readonly kind: "launched"; readonly displayName: string }
  | { readonly kind: "paused" };

/**
 * How the server takes and gives back a workspace. The CLI implements it
 * with the workspace's file lock and this process's record in
 * `.swamp/start/servers/<pid>.json`; tests pass {@link NO_CLAIMS}. Several
 * `swamp start` processes may serve one workspace at once.
 */
export interface StartWorkspaceClaims {
  /** Runs `open` while holding the workspace, then records this server. */
  claim<T>(
    name: string,
    workspacePath: string,
    open: () => Promise<T>,
  ): Promise<T>;
  release(workspacePath: string): Promise<void>;
}

export const NO_CLAIMS: StartWorkspaceClaims = {
  claim: (_name, _path, open) => open(),
  release: () => Promise.resolve(),
};

export interface StartServerOptions {
  readonly ctx: LibSwampContext;
  readonly deps: StartDeps;
  readonly token: string;
  readonly distDir: string;
  readonly claims?: StartWorkspaceClaims;
  /** Told each time the page opens a workspace. */
  readonly onWorkspaceOpened?: (
    workspacePath: string,
    created: boolean,
  ) => void;
  readonly timeouts?: StartServerTimeouts;
  /**
   * The local dashboard's workspace routes (`/w/<workspace>/...` and the
   * workspace list). A dashboard tab keeps the server up like the start
   * page does.
   */
  readonly hub?: WorkspaceHub;
}

export interface StartServerHandle {
  readonly port: number;
  /** Resolves when an end condition is met. */
  readonly ended: Promise<StartServerEnd>;
  /**
   * Opens (creating if needed) the named workspace, as the page would. A
   * new one is created in `location.parent` when given.
   */
  openWorkspace(
    name: string,
    location?: StartWorkspaceLocationInput,
  ): Promise<StartStatus>;
  /** The workspace being served, or null before one is chosen. */
  workspacePath(): string | null;
  shutdown(): Promise<void>;
}

const RequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start.status"), id: z.string() }),
  z.object({
    type: z.literal("start.task.save"),
    id: z.string(),
    payload: z.object({ text: z.string() }),
  }),
  z.object({ type: z.literal("start.back"), id: z.string() }),
  z.object({ type: z.literal("start.harness.list"), id: z.string() }),
  z.object({
    type: z.literal("start.harness.choose"),
    id: z.string(),
    payload: z.object({
      id: z.string(),
      tools: z.array(z.string()).max(16).optional(),
    }),
  }),
  z.object({ type: z.literal("start.signin"), id: z.string() }),
  z.object({
    type: z.literal("start.launch"),
    id: z.string(),
    payload: z.object({ trustConfirmed: z.literal(true) }),
  }),
  z.object({ type: z.literal("start.new_task"), id: z.string() }),
  z.object({ type: z.literal("start.copied"), id: z.string() }),
  z.object({
    type: z.literal("start.folder.pick"),
    id: z.string(),
    payload: z.object({ purpose: z.enum(["import", "location"]) }).optional(),
  }),
  z.object({
    type: z.literal("start.workspace.location.check"),
    id: z.string(),
    payload: z.object({
      name: z.string().max(64),
      parent: z.string().max(MAX_WORKSPACE_PARENT_LENGTH).optional(),
    }),
  }),
  z.object({
    type: z.literal("start.folder.check"),
    id: z.string(),
    payload: z.object({ path: z.string().max(4096) }),
  }),
  z.object({ type: z.literal("start.workspaces.list"), id: z.string() }),
  z.object({
    type: z.literal("start.workspace.choose"),
    id: z.string(),
    payload: z.object({
      name: z.string(),
      // Where to create it when it is new. Only absolute or `~` paths: the
      // page's folder is never resolved against this process's own.
      parent: z.string().max(MAX_WORKSPACE_PARENT_LENGTH).optional(),
    }),
  }),
  z.object({ type: z.literal("start.workspace.leave"), id: z.string() }),
  z.object({
    type: z.literal("start.workspace.import"),
    id: z.string(),
    payload: z.object({
      path: z.string().max(4096),
      name: z.string().max(64).optional(),
    }),
  }),
  z.object({
    type: z.literal("start.resume"),
    id: z.string(),
    payload: z.object({ trustConfirmed: z.boolean().optional() }).optional(),
  }),
  z.object({ type: z.literal("start.new_task.cancel"), id: z.string() }),
  z.object({ type: z.literal("start.tasks.list"), id: z.string() }),
  z.object({
    type: z.literal("start.tools.add"),
    id: z.string(),
    payload: z.object({ tools: z.array(z.string()).max(16) }),
  }),
  z.object({
    type: z.literal("start.agent.open"),
    id: z.string(),
    payload: z.object({
      id: z.string(),
      trustConfirmed: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal("start.tasks.show"), id: z.string() }),
  z.object({
    type: z.literal("start.task.open"),
    id: z.string(),
    payload: z.object({ id: z.string() }),
  }),
]);

type StartRequest = z.infer<typeof RequestSchema>;

const SUBPROTOCOL_PREFIX = "bearer.";

/** The bearer token a WebSocket upgrade offers in its subprotocol list. */
function offeredToken(req: Request): string | null {
  const header = req.headers.get("sec-websocket-protocol");
  if (!header) return null;
  for (const entry of header.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.startsWith(SUBPROTOCOL_PREFIX)) {
      return trimmed.slice(SUBPROTOCOL_PREFIX.length);
    }
  }
  return null;
}

/** A request the server refused, with the code the page reads. */
export class StartServerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StartServerError";
  }
}

async function lastStatus(
  events: AsyncIterable<StartStatusEvent>,
): Promise<StartStatus> {
  for await (const event of events) {
    if (event.kind === "error") {
      throw new StartServerError(event.error.code, event.error.message, {
        cause: event.error.cause,
      });
    }
    return event.data;
  }
  throw new StartServerError("internal", "No status was produced.");
}

/**
 * Runs a launch-like stream (launch, resume, open agent), passing each
 * progress event to `forward`. Answers the final status and whether the
 * `launched` event says the window opened.
 */
async function launchStatus(
  events: AsyncIterable<StartLaunchEvent>,
  forward: (event: StartLaunchEvent) => void,
  what: string,
): Promise<{ status: StartStatus; opened: boolean | undefined }> {
  let status: StartStatus | undefined;
  let opened: boolean | undefined;
  for await (const event of events) {
    if (event.kind === "completed") {
      status = event.data;
    } else if (event.kind === "error") {
      throw new StartServerError(event.error.code, event.error.message, {
        cause: event.error.cause,
      });
    } else {
      if (event.kind === "launched") opened = event.opened;
      forward(event);
    }
  }
  if (!status) {
    throw new StartServerError("internal", `${what} produced no status.`);
  }
  return { status, opened };
}

/** A `start.signin` request waiting on the shared sign-in flow. */
interface SignInSubscriber {
  readonly socket: WebSocket;
  readonly id: string;
}

interface SignInFlow {
  readonly subscribers: Set<SignInSubscriber>;
  /** The last device code, replayed to a request that joins late. */
  verification?: StartSignInEvent;
  done?: Promise<void>;
}

/**
 * The loopback server behind `swamp start`. It serves the dashboard bundle,
 * a token-checked `/start/ping` for other `swamp start` processes, and one
 * WebSocket carrying only the `start.*` messages. It binds 127.0.0.1 on an
 * ephemeral port, rejects any Host other than its own (DNS rebinding),
 * checks the Origin of the upgrade, and requires the one-time token as a
 * `bearer.` subprotocol.
 */
export function startStartServer(
  options: StartServerOptions,
): StartServerHandle {
  const { ctx, deps, token, distDir } = options;
  const claims = options.claims ?? NO_CLAIMS;
  const timeouts = options.timeouts ?? DEFAULT_START_SERVER_TIMEOUTS;
  // The workspace being served, and the name it was opened under (an
  // imported folder's name can differ from its registered one).
  let bound: { readonly path: string; readonly name: string } | null = null;
  let stopping = false;

  // One command at a time, so two tabs can never launch twice. Every read
  // of the bound workspace and every change to the screen flags happens
  // inside a queued function, so a queued switch can never interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = () =>
      stopping
        ? Promise.reject(
          new StartServerError("stopping", "swamp start is stopping."),
        )
        : work();
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  };
  const drainQueue = async () => {
    let current = queue;
    while (true) {
      await current;
      if (current === queue) return;
      current = queue;
    }
  };

  // End conditions.
  const opened = new Set<WebSocket>();
  let finished = false;
  let copyFallback = false;
  let launchedName: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveEnded!: (end: StartServerEnd) => void;
  const ended = new Promise<StartServerEnd>((resolve) => {
    resolveEnded = resolve;
  });
  const finish = (end: StartServerEnd) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolveEnded(end);
  };
  const reevaluate = () => {
    clearTimeout(timer);
    if (finished) return;
    if (opened.size === 0) {
      // A copy-command launch opened no window, so it ends as a plain stop.
      timer = launchedName !== undefined
        ? setTimeout(
          () =>
            finish(
              copyFallback
                ? { kind: "paused" }
                : { kind: "launched", displayName: launchedName! },
            ),
          timeouts.afterLaunchIdleMs,
        )
        : setTimeout(
          () => finish({ kind: "paused" }),
          timeouts.beforeLaunchIdleMs,
        );
    } else if (copyFallback) {
      timer = setTimeout(
        () => finish({ kind: "paused" }),
        timeouts.copyFallbackMs,
      );
    }
  };

  // Tasks this process launched. Right after a launch the page shows the
  // launched screen; a task launched by an earlier run shows on the home,
  // so the page never re-sends its brief.
  const launchedHere = new Set<string>();
  // The task the page has open in the bound workspace, or null while a new
  // task is written. It lives here, not on disk: no task is special.
  let selectedTask: string | null = null;
  // The task that was open when "New task" was chosen, for Cancel.
  let previousTask: string | null = null;
  // "home": the workspace's home, every task and the open one's summary.
  // "flow": the open task's own step (task, agent, trust, launched).
  let view: "home" | "flow" = "flow";
  const present = (status: StartStatus): StartStatus => {
    if (status.workspacePath === null) return status;
    const named = bound !== null && status.workspacePath === bound.path
      ? { ...status, workspaceName: bound.name }
      : status;
    if (named.screen === "blocked" || named.screen === "sign_in") return named;
    if (view === "home" && (named.tasks?.length ?? 0) > 0) {
      return { ...named, screen: "home" };
    }
    return named.screen === "launched" &&
        !(named.taskId !== undefined && launchedHere.has(named.taskId))
      ? { ...named, screen: "home" }
      : named;
  };

  /**
   * The status of the bound workspace and its open task. A task that has
   * gone (its record deleted) is dropped from the selection.
   */
  const readStatus = async (path: string): Promise<StartStatus> => {
    try {
      return await lastStatus(
        startStatus(ctx, deps, {
          workspacePath: path,
          ...(selectedTask !== null ? { taskId: selectedTask } : {}),
        }),
      );
    } catch (error) {
      if (
        !(error instanceof StartServerError) || error.code !== "task_missing"
      ) {
        throw error;
      }
      selectedTask = null;
      view = "home";
      return await lastStatus(startStatus(ctx, deps, { workspacePath: path }));
    }
  };

  /** The open task's id; the commands that change a task need one. */
  const requireTask = (): string => {
    if (selectedTask === null) {
      throw new StartServerError("no_task", "Write the task first.");
    }
    return selectedTask;
  };

  const requireWorkspace = (): string => {
    if (bound === null) {
      throw new StartServerError(
        "no_workspace",
        "Choose a workspace first.",
      );
    }
    return bound.path;
  };

  /** Refuses the request unless this machine holds a sign-in (no network). */
  const requireSignedIn = async (): Promise<void> => {
    if ((await deps.checkSignedIn(false)).kind !== "signed_in") {
      throw new StartServerError("not_signed_in", "Sign in first.");
    }
  };

  /** Queues work that needs a sign-in. */
  const signedIn = <T>(work: () => Promise<T>): Promise<T> =>
    enqueue(async () => {
      await requireSignedIn();
      return await work();
    });

  let picking: Promise<{ path: string | null }> | null = null;
  const pickFolder = (
    purpose: "import" | "location",
  ): Promise<{ path: string | null }> => {
    if (stopping) {
      return Promise.reject(
        new StartServerError("stopping", "swamp start is stopping."),
      );
    }
    picking ??= (async () => {
      try {
        return await startPickFolder(ctx, deps, { purpose });
      } catch (error) {
        if (error instanceof UserError) {
          throw new StartServerError(
            error.code ?? "user_error",
            error.message,
            { cause: error },
          );
        }
        throw error;
      } finally {
        picking = null;
      }
    })();
    return picking;
  };

  /** Queues work on the bound workspace, read when the work runs. */
  const inWorkspace = <T>(work: (path: string) => Promise<T>): Promise<T> =>
    signedIn(() => work(requireWorkspace()));

  // A launch, resume or agent open that arrives while the same one is
  // running for the same workspace (a double click, a second tab) shares its
  // result instead of opening a second window.
  const inFlight = new Map<string, Promise<StartStatus>>();
  const deduped = (
    action: string,
    run: (path: string) => Promise<StartStatus>,
    options: { sameTask?: boolean } = {},
  ): Promise<StartStatus> => {
    const expected = bound?.path ?? null;
    const expectedTask = selectedTask;
    const key = `${action}:${expected}:${selectedTask}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const tracked: Promise<StartStatus> = inWorkspace(async (path) => {
      if (path !== expected) {
        throw new StartServerError(
          "workspace_changed",
          "The workspace changed before this ran. Try again.",
        );
      }
      // A launch or resume acts on the task the page showed when it was
      // asked for; another tab opening a different task meanwhile must not
      // change which task's agent opens.
      if (options.sameTask && selectedTask !== expectedTask) {
        throw new StartServerError(
          "task_changed",
          "Another task was opened before this ran. Try again.",
        );
      }
      return await run(path);
    }).finally(() => {
      if (inFlight.get(key) === tracked) inFlight.delete(key);
    });
    inFlight.set(key, tracked);
    return tracked;
  };

  /**
   * Drops the last launch when the page moves to another workspace or back
   * to the picker, so the run doesn't end as "launched" for a workspace the
   * page has left.
   */
  const forgetLaunch = () => {
    launchedName = undefined;
    copyFallback = false;
    reevaluate();
  };

  const releaseQuietly = async (path: string) => {
    try {
      await claims.release(path);
    } catch (error) {
      ctx.logger.warn`swamp start couldn't release ${path}: ${error}`;
    }
  };

  /** Opens a workspace; runs inside the queue. */
  const openWorkspaceNow = async (
    name: string,
    location: StartWorkspaceLocationInput = {},
  ): Promise<StartStatus> => {
    let path: string;
    try {
      path = await resolveStartWorkspacePath(deps, name, location);
    } catch (error) {
      if (error instanceof UserError) {
        throw new StartServerError(
          error.code?.startsWith("parent_") ? error.code : "invalid_name",
          error.message,
          { cause: error },
        );
      }
      throw error;
    }
    if (bound !== null && path === bound.path) {
      return present(await readStatus(path));
    }
    let created = false;
    let status: StartStatus;
    try {
      status = await claims.claim(name, path, async () => {
        for await (
          const event of startOpenWorkspace(ctx, deps, {
            workspaceName: name,
            ...location,
          })
        ) {
          if (event.kind === "workspace_ready") created = event.created;
          if (event.kind === "error") {
            throw new StartServerError(event.error.code, event.error.message, {
              cause: event.error.cause,
            });
          }
          if (event.kind === "completed") return event.data;
        }
        throw new StartServerError("internal", "No status was produced.");
      });
    } catch (error) {
      throw error instanceof Error ? markErrorPaths(error, [path]) : error;
    }
    const previous = bound;
    bound = { path, name };
    // The newest task opens on the home; a workspace with none starts on a
    // new task.
    selectedTask = status.taskId ?? null;
    previousTask = null;
    view = selectedTask !== null ? "home" : "flow";
    forgetLaunch();
    // The new workspace is already open: failing to tidy up the old one
    // must not turn the switch into an error.
    if (previous !== null) await releaseQuietly(previous.path);
    options.onWorkspaceOpened?.(path, created);
    return present(status);
  };

  const openWorkspace = (
    name: string,
    location?: StartWorkspaceLocationInput,
  ): Promise<StartStatus> => enqueue(() => openWorkspaceNow(name, location));

  const leaveWorkspace = (): Promise<StartStatus> =>
    signedIn(async () => {
      const previous = bound;
      bound = null;
      selectedTask = null;
      previousTask = null;
      view = "flow";
      forgetLaunch();
      if (previous !== null) await releaseQuietly(previous.path);
      return await lastStatus(startStatus(ctx, deps, { workspacePath: null }));
    });

  const currentStatus = (): Promise<StartStatus> =>
    enqueue(async () =>
      bound === null
        ? await lastStatus(startStatus(ctx, deps, { workspacePath: null }))
        : present(await readStatus(bound.path))
    );

  // Sign-in polls for minutes and changes no session state, so it runs
  // outside the queue. There is one flow at a time; a `start.signin` that
  // arrives while it runs (a reload, a second tab) joins it.
  let signIn: SignInFlow | null = null;
  const sendTo = (subscriber: SignInSubscriber, frame: unknown): boolean => {
    if (subscriber.socket.readyState !== WebSocket.OPEN) return false;
    subscriber.socket.send(JSON.stringify(frame));
    return true;
  };
  const broadcast = (
    flow: SignInFlow,
    frameFor: (id: string) => unknown,
  ) => {
    for (const subscriber of [...flow.subscribers]) {
      if (!sendTo(subscriber, frameFor(subscriber.id))) {
        flow.subscribers.delete(subscriber);
      }
    }
  };
  const runSignIn = async (flow: SignInFlow): Promise<void> => {
    try {
      for await (const event of startSignIn(ctx, deps)) {
        if (event.kind === "device_verification") flow.verification = event;
        broadcast(flow, (id) => ({ type: "start.signin", id, event }));
      }
    } finally {
      if (signIn === flow) signIn = null;
    }
    let status: StartStatus;
    try {
      status = await currentStatus();
    } catch (error) {
      const code = error instanceof StartServerError ? error.code : "internal";
      const message = error instanceof Error ? error.message : String(error);
      broadcast(
        flow,
        (id) => ({ type: "error", id, error: { code, message } }),
      );
      return;
    }
    broadcast(flow, (id) => ({ type: "start.signin", id, payload: status }));
    broadcast(flow, (id) => ({ type: "done", id }));
  };
  const joinSignIn = (subscriber: SignInSubscriber): Promise<void> => {
    if (signIn !== null) {
      signIn.subscribers.add(subscriber);
      if (signIn.verification) {
        sendTo(subscriber, {
          type: "start.signin",
          id: subscriber.id,
          event: signIn.verification,
        });
      }
      return signIn.done ?? Promise.resolve();
    }
    const flow: SignInFlow = { subscribers: new Set([subscriber]) };
    signIn = flow;
    flow.done = runSignIn(flow);
    return flow.done;
  };

  async function handle(
    socket: WebSocket,
    request: StartRequest,
  ): Promise<void> {
    const send = (frame: unknown) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    };
    const respond = (payload: unknown) =>
      send({ type: request.type, id: request.id, payload });
    const forward = (event: StartLaunchEvent) =>
      send({ type: request.type, id: request.id, event });
    /** Runs one status-answering command on the bound workspace. */
    const statusOp = async (
      events: (path: string) => AsyncIterable<StartStatusEvent>,
      before?: () => void,
    ) =>
      respond(
        await inWorkspace(async (path) => {
          before?.();
          return present(await lastStatus(events(path)));
        }),
      );

    switch (request.type) {
      case "start.status":
        return respond(await currentStatus());
      case "start.workspaces.list":
        return respond(
          await signedIn(() => startListWorkspaces(ctx, deps)),
        );
      case "start.workspace.choose":
        return respond(
          await signedIn(() =>
            openWorkspaceNow(
              request.payload.name,
              request.payload.parent !== undefined
                ? { parent: request.payload.parent }
                : {},
            )
          ),
        );
      case "start.workspace.import":
        return respond(
          await signedIn(async () => {
            let imported: { name: string };
            try {
              imported = await startImportWorkspace(ctx, deps, request.payload);
            } catch (error) {
              if (error instanceof UserError) {
                throw new StartServerError(
                  error.code ?? "user_error",
                  error.message,
                  { cause: error },
                );
              }
              throw error;
            }
            return await openWorkspaceNow(imported.name);
          }),
        );
      case "start.workspace.leave":
        return respond(await leaveWorkspace());
      case "start.task.save":
        return respond(
          await inWorkspace(async (path) => {
            const creating = selectedTask === null;
            const status = await lastStatus(
              startSaveTask(ctx, deps, {
                workspacePath: path,
                ...(selectedTask !== null ? { taskId: selectedTask } : {}),
                text: request.payload.text,
              }),
            );
            if (creating) {
              // A new task: the run no longer ends as the last one's launch.
              copyFallback = false;
              launchedName = undefined;
              reevaluate();
            }
            selectedTask = status.taskId ?? null;
            previousTask = null;
            view = "flow";
            return present(status);
          }),
        );
      case "start.tools.add":
        return await statusOp((path) =>
          startAddTools(ctx, deps, {
            workspacePath: path,
            ...(selectedTask !== null ? { taskId: selectedTask } : {}),
            tools: request.payload.tools,
          })
        );
      case "start.agent.open": {
        const harness = request.payload.id;
        const trustConfirmed = request.payload.trustConfirmed === true;
        const status = await deduped(
          `agent:${harness}`,
          async (path) => {
            const result = await launchStatus(
              startOpenAgent(ctx, deps, {
                workspacePath: path,
                ...(selectedTask !== null ? { taskId: selectedTask } : {}),
                harness,
                trustConfirmed,
              }),
              forward,
              "Open",
            );
            launchedName = findHarness(harness)?.displayName ?? "Your agent";
            // The status describes the open task's launch; this open's own
            // outcome is in its `launched` event.
            if (result.opened !== undefined) copyFallback = !result.opened;
            reevaluate();
            return present(result.status);
          },
        );
        respond(status);
        return send({ type: "done", id: request.id });
      }
      case "start.tasks.list":
        return respond({
          tasks: await inWorkspace((path) =>
            startListTasks(ctx, deps, { workspacePath: path })
          ),
        });
      case "start.tasks.show":
        // The workspace's home; with no task open, the newest one.
        return respond(
          await inWorkspace(async (path) => {
            if (selectedTask === null) {
              selectedTask =
                (await startListTasks(ctx, deps, { workspacePath: path }))[0]
                  ?.id ?? null;
            }
            previousTask = null;
            view = "home";
            return present(await readStatus(path));
          }),
        );
      case "start.task.open":
        // Opening a task changes nothing on disk: a launched one shows on
        // the home, any other at its own step.
        return respond(
          await inWorkspace(async (path) => {
            const status = await lastStatus(
              startStatus(ctx, deps, {
                workspacePath: path,
                taskId: request.payload.id,
              }),
            );
            selectedTask = request.payload.id;
            previousTask = null;
            view = status.screen === "launched" ? "home" : "flow";
            return present(status);
          }),
        );
      case "start.new_task":
        return respond(
          await inWorkspace(async (path) => {
            previousTask = selectedTask;
            selectedTask = null;
            view = "flow";
            // The page has moved past the copy-command screen.
            copyFallback = false;
            reevaluate();
            return present(await readStatus(path));
          }),
        );
      case "start.new_task.cancel":
        return respond(
          await inWorkspace(async (path) => {
            selectedTask = previousTask ??
              (await startListTasks(ctx, deps, { workspacePath: path }))[0]
                ?.id ??
              null;
            previousTask = null;
            view = selectedTask !== null ? "home" : "flow";
            return present(await readStatus(path));
          }),
        );
      case "start.back":
        return await statusOp((path) =>
          startBack(ctx, deps, { workspacePath: path, taskId: requireTask() })
        );
      case "start.harness.choose":
        return await statusOp((path) =>
          startChooseHarness(ctx, deps, {
            workspacePath: path,
            taskId: requireTask(),
            harness: request.payload.id,
            tools: request.payload.tools,
          })
        );
      case "start.harness.list": {
        const harnesses = await enqueue(() => startListHarnesses(ctx, deps));
        return respond({ harnesses });
      }
      case "start.resume": {
        const trustConfirmed = request.payload?.trustConfirmed === true;
        const status = await deduped("resume", async (path) => {
          const { status } = await launchStatus(
            startResume(ctx, deps, {
              workspacePath: path,
              taskId: requireTask(),
              trustConfirmed,
            }),
            forward,
            "Resume",
          );
          if (status.launch && status.harness) {
            launchedName = status.harness.displayName;
            copyFallback = !status.launch.opened;
            reevaluate();
          }
          return present(status);
        }, { sameTask: true });
        respond(status);
        return send({ type: "done", id: request.id });
      }
      case "start.copied":
        // Queued, so a launch already in flight can't set the fallback
        // again after the user has copied its command.
        await enqueue(() => {
          copyFallback = false;
          reevaluate();
          return Promise.resolve();
        });
        return respond({ ok: true });
      case "start.signin":
        return await joinSignIn({ socket, id: request.id });
      case "start.folder.check":
        // Reads only, so it isn't queued behind workspace changes.
        return respond(
          await signedIn(() =>
            startCheckFolder(ctx, deps, { path: request.payload.path })
          ),
        );
      case "start.workspace.location.check":
        // Reads only, so it isn't queued behind workspace changes.
        return respond(
          await signedIn(() =>
            startCheckWorkspaceLocation(ctx, deps, {
              name: request.payload.name,
              ...(request.payload.parent !== undefined
                ? { parent: request.payload.parent }
                : {}),
            })
          ),
        );
      case "start.folder.pick":
        // Not queued: the dialog waits on the user for as long as they
        // like, and it reads and changes nothing on the server, so it must
        // not hold up other requests. A second request while one is open
        // shares it rather than opening a second dialog.
        return respond(
          await pickFolder(request.payload?.purpose ?? "import"),
        );
      case "start.launch": {
        const status = await deduped("launch", async (path) => {
          const taskId = requireTask();
          const { status } = await launchStatus(
            startLaunch(ctx, deps, { workspacePath: path, taskId }),
            forward,
            "Launch",
          );
          launchedHere.add(taskId);
          view = "flow";
          if (status.launch && status.harness) {
            launchedName = status.harness.displayName;
            copyFallback = !status.launch.opened;
            reevaluate();
          }
          return present(status);
        }, { sameTask: true });
        respond(status);
        return send({ type: "done", id: request.id });
      }
    }
  }

  const sockets = new Set<WebSocket>();

  function onSocket(socket: WebSocket) {
    sockets.add(socket);
    socket.onopen = () => {
      opened.add(socket);
      reevaluate();
    };
    socket.onclose = () => {
      sockets.delete(socket);
      if (signIn !== null) {
        for (const subscriber of [...signIn.subscribers]) {
          if (subscriber.socket === socket) {
            signIn.subscribers.delete(subscriber);
          }
        }
      }
      // Only a socket that opened was counted.
      if (opened.delete(socket)) reevaluate();
    };
    socket.onmessage = (message) => {
      let id: string | undefined;
      const fail = (code: string, text: string) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "error",
              id,
              error: { code, message: text },
            }),
          );
        }
      };
      let parsed: StartRequest;
      try {
        const raw = JSON.parse(String(message.data));
        id = typeof raw?.id === "string" ? raw.id : undefined;
        parsed = RequestSchema.parse(raw);
      } catch {
        fail("invalid_request", "Unrecognised request.");
        return;
      }
      handle(socket, parsed).catch((error) => {
        if (error instanceof StartServerError) {
          fail(error.code, error.message);
        } else {
          ctx.logger.error`swamp start request failed: ${error}`;
          fail(
            "internal",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    };
  }

  let port = 0;
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    },
    async (req) => {
      const host = req.headers.get("host");
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        return new Response("Misdirected request", { status: 421 });
      }
      const url = new URL(req.url);
      if (
        url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")
      ) {
        return Response.redirect(
          new URL("/dashboard/start", req.url).toString(),
          302,
        );
      }
      if (url.pathname === "/start/ping") {
        // Another `swamp start` asking whether this one is live. It is not
        // a page, so it never touches the end conditions.
        const offered = req.headers.get(START_PING_TOKEN_HEADER);
        if (offered === null || !timingSafeEqual(offered, token)) {
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/start/ws") {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Expected a WebSocket", { status: 426 });
        }
        const origin = validateWebSocketOrigin(
          req.headers.get("origin"),
          host,
          "127.0.0.1",
          false,
        );
        if (!origin.allowed) {
          return new Response("Forbidden origin", { status: 403 });
        }
        const offered = offeredToken(req);
        if (offered === null || !timingSafeEqual(offered, token)) {
          return new Response("Unauthorized", { status: 401 });
        }
        let upgraded: { socket: WebSocket; response: Response };
        try {
          upgraded = Deno.upgradeWebSocket(req, {
            protocol: SUBPROTOCOL_PREFIX + token,
          });
        } catch {
          return new Response("Malformed WebSocket upgrade", { status: 400 });
        }
        onSocket(upgraded.socket);
        return upgraded.response;
      }
      const hubAnswer = await options.hub?.handle(req, trackDashboardSocket);
      if (hubAnswer) return hubAnswer;
      const asset = await serveDashboardRoute(distDir, req);
      if (asset) return asset;
      return new Response("Not found", { status: 404 });
    },
  );
  port = server.addr.port;
  reevaluate();

  function trackDashboardSocket(socket: WebSocket): void {
    sockets.add(socket);
    socket.addEventListener("open", () => {
      opened.add(socket);
      reevaluate();
    });
    socket.addEventListener("close", () => {
      sockets.delete(socket);
      if (opened.delete(socket)) reevaluate();
    });
  }

  return {
    port,
    ended,
    openWorkspace,
    workspacePath: () => bound?.path ?? null,
    shutdown: async () => {
      // Queued work from here on bails, so nothing claims after the
      // release below.
      stopping = true;
      finish({ kind: "paused" });
      for (const socket of sockets) socket.close(1001, "swamp start stopped");
      await drainQueue();
      // The hub first: it ends the dashboard streams it forwards, which
      // the server's shutdown would otherwise wait on forever.
      await options.hub?.shutdown();
      await server.shutdown();
      if (bound !== null) {
        const path = bound.path;
        bound = null;
        await claims.release(path);
      }
    },
  };
}
