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

import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import { escapeControlCharacters } from "../../domain/control_characters.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type {
  HostedWorkspaceChangeData,
  HostedWorkspaceSummaryData,
  WorkspaceCreateResponse,
} from "../../serve/protocol.ts";
import type { OutputMode } from "./output.ts";

export type WorkspaceChangeVerb = "suspend" | "resume" | "rm";

// every string below except the caller's own command target came from the root
const shown = escapeControlCharacters;

function resumeCommand(name: string, commandTarget: string): string {
  return `swamp serve workspace resume ${name}${commandTarget}`;
}

/** a suspended workspace the host has not reported on yet has no serve */
function observedState(summary: HostedWorkspaceSummaryData): string {
  if (summary.state !== null) return shown(String(summary.state));
  return summary.wanted === "suspended" ? "stopped" : "unknown";
}

function stateText(summary: HostedWorkspaceSummaryData): string {
  const observed = observedState(summary);
  if (summary.wanted === null) return `${observed} (wanted file unreadable)`;
  const pending = summary.wanted === "deleted" ||
    (summary.wanted === "suspended" && observed !== "stopped") ||
    (summary.wanted === "active" && observed === "stopped");
  return pending ? `${observed} → ${shown(String(summary.wanted))}` : observed;
}

function colorState(text: string): string {
  const observed = text.split(" ")[0];
  switch (observed) {
    case "ready":
      return text.replace(observed, green(observed));
    case "failed":
      return text.replace(observed, red(observed));
    case "backoff":
    case "starting":
      return text.replace(observed, yellow(observed));
    default:
      return text;
  }
}

function restartsText(summary: HostedWorkspaceSummaryData): string {
  return summary.restarts === null ? "-" : shown(String(summary.restarts));
}

export function renderWorkspaceCreate(
  data: WorkspaceCreateResponse["data"],
  mode: OutputMode,
  commandTarget: string,
): void {
  const start = resumeCommand(data.name, commandTarget);
  if (mode === "json") {
    console.log(JSON.stringify(
      {
        name: data.name,
        address: data.address,
        wanted: data.wanted,
        state: "stopped",
        start,
      },
      null,
      2,
    ));
    return;
  }
  writeOutput([
    `${bold(cyan("Created:"))} ${bold(shown(data.name))}`,
    `${bold(cyan("Address:"))} ${shown(data.address)}`,
    `${bold(cyan("State:"))} stopped`,
    "",
    `Start it with: ${bold(shown(start))}`,
  ].join("\n"));
}

export function renderWorkspaceList(
  workspaces: readonly HostedWorkspaceSummaryData[],
  mode: OutputMode,
  commandTarget: string,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ workspaces }, null, 2));
    return;
  }
  if (workspaces.length === 0) {
    writeOutput([
      "No hosted workspaces.",
      dim(
        `Create one with: swamp serve workspace create <name>${commandTarget}`,
      ),
    ].join("\n"));
    return;
  }
  const headers = ["NAME", "ADDRESS", "STATE", "RESTARTS"];
  const rows = workspaces.map((summary) => [
    shown(summary.name),
    shown(summary.address),
    stateText(summary),
    restartsText(summary),
  ]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length))
  );
  const lines = [
    dim(headers.map((header, i) => header.padEnd(widths[i])).join("  ")),
    ...rows.map((row) =>
      row.map((cell, i) => {
        const padded = cell.padEnd(widths[i]);
        return i === 2 ? colorState(padded) : padded;
      }).join("  ").trimEnd()
    ),
  ];
  writeOutput(lines.join("\n"));
}

export function renderWorkspaceGet(
  summary: HostedWorkspaceSummaryData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const lines = [
    `${bold(cyan("Workspace:"))} ${bold(shown(summary.name))}`,
    `${bold(cyan("Address:"))} ${shown(summary.address)}`,
    `${bold(cyan("State:"))} ${colorState(observedState(summary))}`,
    `${bold(cyan("Wanted:"))} ${
      summary.wanted === null ? "unreadable" : shown(String(summary.wanted))
    }`,
    `${bold(cyan("Restarts:"))} ${restartsText(summary)}`,
  ];
  if (summary.state !== "ready" && summary.reason !== null) {
    lines.push(`${bold(cyan("Reason:"))} ${shown(summary.reason)}`);
  }
  writeOutput(lines.join("\n"));
}

export function renderWorkspaceChange(
  verb: WorkspaceChangeVerb,
  data: HostedWorkspaceChangeData,
  mode: OutputMode,
  commandTarget: string,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const plainName = shown(data.name);
  const name = bold(plainName);
  const lines = verb === "suspend"
    ? [
      `Workspace ${name} is suspended. The host stops its serve on its next scan and keeps everything.`,
      dim(
        `Watch it with: swamp serve workspace get ${plainName}${commandTarget}`,
      ),
    ]
    : verb === "resume"
    ? [
      `Workspace ${name} is set to start. The host starts its serve on its next scan.`,
      dim(
        `Watch it with: swamp serve workspace get ${plainName}${commandTarget}`,
      ),
    ]
    : [
      `Workspace ${name} is marked for removal. The host stops its serve and removes its folder on its next scan.`,
      dim(`Watch it with: swamp serve workspace list${commandTarget}`),
    ];
  writeOutput(lines.join("\n"));
}

export function renderWorkspaceRmCancelled(
  name: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ name, removed: false }, null, 2));
    return;
  }
  writeOutput(
    `Nothing was removed: workspace ${bold(shown(name))} is unchanged.`,
  );
}
