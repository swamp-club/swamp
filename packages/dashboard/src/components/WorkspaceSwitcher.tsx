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
import { dashboardBaseFor, withLocalToken } from "../client/workspace_path.ts";
import {
  parseWorkspaceList,
  type WorkspaceList,
} from "../client/workspace_list.ts";

/**
 * The local dashboard's workspace picker: every workspace `swamp start`
 * knows, and the way back to the start page. Switching loads the other
 * workspace's dashboard, which a separate swamp process serves. It shows
 * nothing until the list arrives, and nothing for a fixed repo.
 */
export function WorkspaceSwitcher({ current }: { current: string }) {
  const [list, setList] = useState<WorkspaceList | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/local/workspaces", {
      headers: withLocalToken(),
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => setList(parseWorkspaceList(body)))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  if (list === null || !list.switchable) return null;
  const options = list.workspaces;
  const known = options.some((w) => w.name === current);
  const currentPath = options.find((w) => w.name === current)?.path;

  return (
    <div className="workspace-switcher">
      <label className="workspace-switcher-label" htmlFor="workspace-switch">
        Workspace
      </label>
      <select
        id="workspace-switch"
        className="workspace-switcher-select"
        value={current}
        title={currentPath}
        onChange={(e) => {
          if (e.target.value !== current) {
            location.assign(dashboardBaseFor(e.target.value));
          }
        }}
      >
        {!known && <option value={current}>{current}</option>}
        {options.map((w) => (
          <option key={w.name} value={w.name}>
            {w.name}
          </option>
        ))}
      </select>
      <a className="workspace-switcher-all" href="/dashboard/start">
        All workspaces and tasks
      </a>
    </div>
  );
}
