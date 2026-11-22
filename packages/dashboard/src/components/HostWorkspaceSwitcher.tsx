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

import { useEffect, useState } from "react";
import { CHECK_TIMEOUT_MS, parseAuthInfo } from "../client/connection.ts";
import { createDashboardSessionClient } from "../client/dashboard_session.ts";
import {
  hostSwitcherEntries,
  ROOT_ENTRY_VALUE,
} from "../client/host_workspace_list.ts";
import {
  type PageVisibility,
  type Reader,
  type RootListView,
  type RootSessionEvent,
  startOwnConnectionReader,
  startRootWorkspaceReader,
} from "../client/root_workspace_reader.ts";
import { browserTimers, openServeSocket } from "../client/serve_socket.ts";
import { useSwamp } from "../client/SwampProvider.tsx";
import {
  dashboardBaseFor,
  serverPathFor,
  sessionChannelFor,
} from "../client/workspace_path.ts";

const ROOT_SIGN_IN = `${dashboardBaseFor(null)}/`;

const pageVisibility: PageVisibility = {
  visible: () => document.visibilityState === "visible",
  subscribe(onChange) {
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  },
};

async function rootAuthInfo() {
  try {
    const response = await fetch(serverPathFor(null, "/auth/info"), {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return parseAuthInfo(await response.json());
  } catch {
    return null;
  }
}

const rootSession = createDashboardSessionClient(
  (input, init) => fetch(input, init),
  undefined,
  serverPathFor(null, "/auth/dashboard/session"),
);

function rootSessionEvents(
  onEvent: (event: RootSessionEvent) => void,
): () => void {
  if (!("BroadcastChannel" in globalThis)) return () => {};
  const channel = new BroadcastChannel(sessionChannelFor(null));
  channel.onmessage = (message: MessageEvent<unknown>) => {
    const type = (message.data as { type?: unknown } | null)?.type;
    if (type === "logout" || type === "reauthenticated") onEvent(type);
  };
  return () => channel.close();
}

/** The select and the sign-in link, from what the reader last saw. */
export function HostWorkspaceSelect(
  { current, view }: { current: string | null; view: RootListView },
) {
  const entries = hostSwitcherEntries(
    current,
    view.kind === "listed" ? view.workspaces : null,
  );
  const selected = current ?? ROOT_ENTRY_VALUE;
  return (
    <div className="workspace-switcher">
      <label className="workspace-switcher-label" htmlFor="workspace-switch">
        Workspace
      </label>
      <select
        id="workspace-switch"
        className="workspace-switcher-select"
        value={selected}
        onChange={(e) => {
          const entry = entries.find((x) => x.value === e.target.value);
          if (entry !== undefined && entry.value !== selected) {
            location.assign(entry.href);
          }
        }}
      >
        {entries.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        ))}
      </select>
      {view.kind === "sign-in" && (
        <a className="workspace-switcher-all" href={ROOT_SIGN_IN}>
          Sign in to the host to see its workspaces
        </a>
      )}
    </div>
  );
}

/**
 * A serve host's workspace picker: the root and every workspace
 * `workspace.list` on the root returns. Switching loads the other
 * workspace's dashboard, which asks for its own sign-in.
 */
export function HostWorkspaceSwitcher({ current }: { current: string | null }) {
  const { connected, request } = useSwamp();
  const [view, setView] = useState<RootListView>({ kind: "loading" });
  const ownConnection = current === null;
  // a workspace page's reader has its own socket, so the page's connection never restarts it
  const ready = ownConnection ? connected : true;
  const ownRequest = ownConnection ? request : null;

  useEffect(() => {
    if (!ready) return;
    let reader: Reader;
    if (ownRequest !== null) {
      reader = startOwnConnectionReader({
        read: () => ownRequest("workspace.list"),
        timers: browserTimers,
        visibility: pageVisibility,
        onChange: setView,
      });
    } else {
      reader = startRootWorkspaceReader({
        authInfo: rootAuthInfo,
        sessionRestored: () => rootSession.restore(),
        openSocket: (handlers) =>
          openServeSocket(undefined, handlers, serverPathFor(null, "/")),
        timers: browserTimers,
        visibility: pageVisibility,
        sessionEvents: rootSessionEvents,
        onChange: setView,
      });
    }
    return () => reader.stop();
  }, [ready, ownRequest]);

  return <HostWorkspaceSelect current={current} view={view} />;
}
