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

import { localToken, serverPath, withLocalToken } from "./workspace_path.ts";
export const DASHBOARD_SESSION_PATH = serverPath("/auth/dashboard/session");
const DASHBOARD_SESSION_TIMEOUT_MS = 5_000;

export type SessionFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

function dashboardOriginHeader(): Record<string, string> | undefined {
  if (typeof location === "undefined") return undefined;
  return { "X-Swamp-Dashboard-Origin": location.origin };
}

/** The origin header, plus the local token on the local dashboard. */
function withLocalOrigin(): Record<string, string> | undefined {
  const origin = dashboardOriginHeader();
  return localToken() === null ? origin : withLocalToken(origin);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(DASHBOARD_SESSION_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Browser adapter for the cookie-backed dashboard session endpoints. */
export function createDashboardSessionClient(fetchFn: SessionFetch) {
  return {
    async restore(signal?: AbortSignal): Promise<boolean> {
      const response = await fetchFn(DASHBOARD_SESSION_PATH, {
        headers: withLocalOrigin(),
        signal: requestSignal(signal),
      });
      await response.body?.cancel();
      if (response.status === 401) return false;
      if (!response.ok) throw new Error("Could not restore dashboard session");
      return true;
    },

    async exchange(token: string): Promise<boolean> {
      const response = await fetchFn(DASHBOARD_SESSION_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        signal: requestSignal(),
      });
      await response.body?.cancel();
      if (response.status === 403) {
        throw new Error(
          "Login rejected by server origin check — see serve logs",
        );
      }
      return response.ok;
    },

    async clear(): Promise<void> {
      const response = await fetchFn(DASHBOARD_SESSION_PATH, {
        method: "DELETE",
        signal: requestSignal(),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Could not log out");
    },
  };
}
