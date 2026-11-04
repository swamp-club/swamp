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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSwamp } from "../client/SwampProvider.tsx";
import { useRequest } from "../client/useRequest.ts";
import {
  type AppEntry,
  type AppListReply,
  launchableApps,
} from "./app_types.ts";

/** How soon an open frame notices a revoke made on another tab or instance. */
export const APPS_REFRESH_MS = 60_000;

export interface AppsState {
  /** True once a listing has arrived. */
  loaded: boolean;
  launchable: readonly AppEntry[];
  canManage: boolean;
  pendingCount: number;
  /** True once a loaded listing no longer offers this app. */
  revoked(name: string): boolean;
  refresh(): void;
}

export function useApps(appOpen: boolean): AppsState {
  const { connected } = useSwamp();
  const { data, refresh } = useRequest<AppListReply>("app.list", undefined, {
    enabled: connected,
  });
  // an answer only ever narrows what is open, so a failed read leaves it alone
  const [loaded, setLoaded] = useState<AppListReply | null>(null);
  useEffect(() => {
    if (data !== null) setLoaded(data);
  }, [data]);

  useEffect(() => {
    const timer = setInterval(() => {
      // an open frame keeps its grant while hidden, so a revoke must still land
      if (appOpen || document.visibilityState === "visible") refresh();
    }, APPS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, appOpen]);

  const launchable = useMemo(
    () => launchableApps(loaded?.data.apps ?? []),
    [loaded],
  );
  const revoked = useCallback(
    (name: string) =>
      loaded !== null && !launchable.some((app) => app.name === name),
    [loaded, launchable],
  );
  return {
    loaded: loaded !== null,
    launchable,
    canManage: loaded?.canManage ?? false,
    pendingCount: (loaded?.data.apps ?? [])
      .filter((app) => app.state !== "enabled").length,
    revoked,
    refresh,
  };
}
