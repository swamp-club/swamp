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

/** A behavior an app may call, and the methods of it the operator approved. */
export interface AppMethodEntry {
  behavior: string;
  type: string;
  methods: string[];
}

export interface AppLaunchReply {
  name: string;
  title: string;
  url: string;
  capabilities: string[];
  run: string[];
  methods: AppMethodEntry[];
}

export interface AppEntry {
  name: string;
  title: string;
  state: "pending" | "enabled" | "changed";
  origin: "extension" | "source" | "local";
  built: boolean;
  dev: boolean;
  version?: string;
  capabilities: string[];
  run: string[];
  methods: AppMethodEntry[];
  capabilityKey: string;
  approvedBy?: string;
  approvedAt?: string;
  platform: string;
  platformProblem?: string;
}

export interface AppListReply {
  data: {
    apps: AppEntry[];
    problems: { path: string; message: string }[];
  };
  canManage: boolean;
}

/** The capabilities an entry asks for, one label each. */
export function capabilityLabels(
  entry: Pick<AppEntry, "capabilities" | "run" | "methods">,
): string[] {
  return [
    ...entry.capabilities,
    ...entry.run.map((name) => `run: ${name}`),
    ...entry.methods.map((method) =>
      `methods of ${method.behavior} (${method.type}): [${
        method.methods.join(", ")
      }]`
    ),
  ];
}

/** Launchable entries, for the sidebar. */
export function launchableApps(apps: readonly AppEntry[]): AppEntry[] {
  return apps.filter((app) =>
    app.state === "enabled" && app.built && app.platformProblem === undefined
  );
}
