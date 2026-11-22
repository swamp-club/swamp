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

import type { AuthInfo, SocketHandlers, Timers } from "./connection.ts";
import {
  HOST_LIST_INTERVAL_MS,
  type HostWorkspace,
  parseHostWorkspaceList,
  rootListAccess,
} from "./host_workspace_list.ts";
import { closeAction } from "./reconnect.ts";
import { settleRequest, type WireFrame } from "./stream.ts";

/** What the host switcher shows: nothing read yet, a sign-in link, or the last list (null when it could not be read). */
export type RootListView =
  | { readonly kind: "loading" }
  | { readonly kind: "sign-in" }
  | { readonly kind: "listed"; readonly workspaces: HostWorkspace[] | null };

export interface PageVisibility {
  visible(): boolean;
  /** calls back on every change; returns the unsubscribe */
  subscribe(onChange: () => void): () => void;
}

export interface Reader {
  stop(): void;
}

interface VisibleTicker {
  /** starts the cadence, reading at once if the tab is visible */
  start(): void;
  /** reads at once and restarts the cadence from now */
  runNow(): void;
  readonly running: boolean;
  stop(): void;
}

/** Reads on a fixed cadence while the tab is visible, and at once on coming back into view. */
function visibleTicker(
  timers: Timers,
  visibility: PageVisibility,
  tick: () => void,
  onHidden: () => void = () => {},
): VisibleTicker {
  let timer: number | null = null;
  let running = false;
  const clear = () => {
    if (timer !== null) timers.clearTimer(timer);
    timer = null;
  };
  const run = () => {
    clear();
    if (!running || !visibility.visible()) return;
    tick();
    timer = timers.setTimer(run, HOST_LIST_INTERVAL_MS);
  };
  let unsubscribe = () => {};
  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe = visibility.subscribe(() => {
        if (visibility.visible()) run();
        else {
          clear();
          onHidden();
        }
      });
      run();
    },
    runNow: run,
    get running() {
      return running;
    },
    stop() {
      running = false;
      clear();
      unsubscribe();
    },
  };
}

export interface OwnConnectionReaderDeps {
  /** `workspace.list` over the page's own connection */
  readonly read: () => Promise<unknown>;
  readonly timers: Timers;
  readonly visibility: PageVisibility;
  readonly onChange: (view: RootListView) => void;
}

/** The root page's reader: it is signed in to the root already, so it asks over its own connection. */
export function startOwnConnectionReader(
  deps: OwnConnectionReaderDeps,
): Reader {
  let stopped = false;
  const ticker = visibleTicker(deps.timers, deps.visibility, () => {
    deps.read().then(
      (payload) => {
        if (!stopped) {
          deps.onChange({
            kind: "listed",
            workspaces: parseHostWorkspaceList(payload),
          });
        }
      },
      () => {
        if (!stopped) deps.onChange({ kind: "listed", workspaces: null });
      },
    );
  });
  ticker.start();
  return {
    stop() {
      stopped = true;
      ticker.stop();
    },
  };
}

/** The part of a WebSocket the root reader drives. */
export interface RootSocket {
  send(data: string): void;
  close(): void;
}

export type RootSessionEvent = "logout" | "reauthenticated";

export interface RootReaderDeps {
  /** the root's `/auth/info`; null when it did not answer usefully */
  readonly authInfo: () => Promise<AuthInfo | null>;
  /** the root's session check, GET `/auth/dashboard/session` */
  readonly sessionRestored: () => Promise<boolean>;
  /** a socket to the root's own address, carrying the root's cookie */
  readonly openSocket: (handlers: SocketHandlers) => RootSocket;
  readonly timers: Timers;
  readonly visibility: PageVisibility;
  /** the root tabs' sign-in and sign-out broadcasts; returns the unsubscribe */
  readonly sessionEvents: (
    onEvent: (event: RootSessionEvent) => void,
  ) => () => void;
  readonly onChange: (view: RootListView) => void;
  readonly newId?: () => string;
}

/**
 * A hosted workspace page's reader. The page's own connection goes to the
 * workspace, so it holds a second socket to the root, only while the tab is
 * visible and only once the root says the browser holds its session: the root
 * is never sent a request it would refuse.
 */
export function startRootWorkspaceReader(deps: RootReaderDeps): Reader {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  let stopped = false;
  let access: "checking" | "sign-in" | "read" = "checking";
  let checking = false;
  let socket: RootSocket | null = null;
  let opened = false;
  let pendingId: string | null = null;

  const emit = (view: RootListView) => {
    if (!stopped) deps.onChange(view);
  };

  const closeSocket = () => {
    const closing = socket;
    socket = null;
    opened = false;
    pendingId = null;
    closing?.close();
  };

  const signIn = () => {
    access = "sign-in";
    closeSocket();
    emit({ kind: "sign-in" });
  };

  const sendRead = () => {
    if (socket === null || !opened) return;
    pendingId = newId();
    socket.send(JSON.stringify({ type: "workspace.list", id: pendingId }));
  };

  const openRootSocket = () => {
    const handlers: SocketHandlers = {
      onOpen: () => {
        if (socket !== created) return;
        opened = true;
        sendRead();
      },
      onMessage: (data) => {
        if (socket !== created || pendingId === null) return;
        let frame: WireFrame;
        try {
          frame = JSON.parse(data);
        } catch {
          return;
        }
        if (typeof frame !== "object" || frame === null) return;
        if (frame.id !== pendingId) return;
        const outcome = settleRequest(frame);
        if (outcome.kind === "ignore") return;
        pendingId = null;
        emit({
          kind: "listed",
          workspaces: outcome.kind === "resolve"
            ? parseHostWorkspaceList(outcome.value)
            : null,
        });
      },
      onClose: (code) => {
        if (socket !== created) return;
        const wasOpen = opened;
        socket = null;
        opened = false;
        pendingId = null;
        const action = closeAction({
          code,
          opened: wasOpen,
          tokenPresented: true,
        });
        if (action === "reauth") signIn();
        // a refused upgrade hides its status: ask the root once before reopening
        else if (action === "probe") startCheck(false);
      },
    };
    const created = deps.openSocket(handlers);
    socket = created;
  };

  const tick = () => {
    if (access !== "read") return;
    if (socket === null) openRootSocket();
    else sendRead();
  };

  const ticker = visibleTicker(deps.timers, deps.visibility, tick, closeSocket);

  let recheckTimer: number | null = null;
  const recheckLater = () => {
    if (recheckTimer !== null || stopped) return;
    recheckTimer = deps.timers.setTimer(() => {
      recheckTimer = null;
      startCheck(false);
    }, HOST_LIST_INTERVAL_MS);
  };

  // readNow is false after a refused upgrade, so a root that keeps refusing is asked once per tick
  async function check(readNow: boolean): Promise<void> {
    if (checking || stopped) return;
    checking = true;
    try {
      const info = await deps.authInfo();
      if (stopped) return;
      if (info === null) {
        emit({ kind: "listed", workspaces: null });
        recheckLater();
        return;
      }
      const signedIn = info.mode === "none"
        ? false
        : await deps.sessionRestored();
      if (stopped) return;
      if (rootListAccess(info.mode, signedIn) === "sign-in") {
        signIn();
        return;
      }
      access = "read";
      if (!ticker.running) ticker.start();
      else if (readNow) ticker.runNow();
    } catch {
      if (stopped) return;
      emit({ kind: "listed", workspaces: null });
      recheckLater();
    } finally {
      checking = false;
    }
  }

  function startCheck(readNow: boolean): void {
    check(readNow).catch(() => {});
  }

  const unsubscribe = deps.sessionEvents((event) => {
    if (event === "logout") signIn();
    else if (access === "sign-in") startCheck(true);
  });

  startCheck(true);

  return {
    stop() {
      stopped = true;
      ticker.stop();
      unsubscribe();
      if (recheckTimer !== null) deps.timers.clearTimer(recheckTimer);
      closeSocket();
    },
  };
}
