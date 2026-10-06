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

export const DASHBOARD_SESSION_PATH = "/auth/dashboard/session";

export type SessionFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Browser adapter for the cookie-backed dashboard session endpoints. */
export function createDashboardSessionClient(fetchFn: SessionFetch) {
  return {
    async restore(signal?: AbortSignal): Promise<boolean> {
      const response = await fetchFn(DASHBOARD_SESSION_PATH, { signal });
      await response.body?.cancel();
      return response.ok;
    },

    async exchange(token: string): Promise<boolean> {
      const response = await fetchFn(DASHBOARD_SESSION_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      await response.body?.cancel();
      return response.ok;
    },

    async clear(): Promise<void> {
      const response = await fetchFn(DASHBOARD_SESSION_PATH, {
        method: "DELETE",
      });
      await response.body?.cancel();
    },
  };
}
