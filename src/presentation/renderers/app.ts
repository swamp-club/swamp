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

import { bold, cyan, dim, green, yellow } from "@std/fmt/colors";
import { escapeControlCharacters } from "../../domain/control_characters.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type {
  AppApproveData,
  AppListData,
  AppRevokeData,
  AppSummary,
} from "../../libswamp/apps/apps.ts";
import type { AppInitData } from "../../libswamp/apps/init.ts";
import type { OutputMode } from "../output/output.ts";

/** Text from an extension, printed without driving the terminal. */
function safe(value: string): string {
  return escapeControlCharacters(value);
}

function stateLabel(app: AppSummary): string {
  if (app.dev) return cyan("dev");
  if (app.state === "enabled") return green("enabled");
  if (app.state === "changed") return yellow("changed since approval");
  return yellow("pending");
}

function grantLine(
  app: Pick<AppSummary, "capabilities" | "run" | "methods">,
): string {
  const parts = [
    ...app.capabilities.map(safe),
    ...app.run.map((name) => `run: ${safe(name)}`),
    ...app.methods.map((method) =>
      `methods of ${safe(method.behavior)} (${safe(method.type)}): [${
        method.methods.map(safe).join(", ")
      }]`
    ),
  ];
  return parts.length > 0 ? parts.join(", ") : dim("none");
}

export function renderAppList(mode: OutputMode, data: AppListData): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.apps.length === 0 && data.problems.length === 0) {
    writeOutput(dim("No apps installed."));
    return;
  }
  const lines: string[] = [];
  for (const app of data.apps) {
    const version = app.version ? ` ${safe(app.version)}` : "";
    lines.push(
      `${bold(safe(app.name))}  ${stateLabel(app)}  ${
        dim(`${safe(app.title)} · ${app.origin}${version}`)
      }`,
    );
    lines.push(`  ${cyan("Asks for:")} ${grantLine(app)}`);
    if (app.approvedBy) {
      lines.push(`  ${cyan("Approved by:")} ${safe(app.approvedBy)}`);
    }
    if (app.platformProblem !== undefined) {
      lines.push(
        `  ${yellow("Cannot open here.")} ${safe(app.platformProblem)}`,
      );
    }
    if (!app.built) {
      lines.push(
        `  ${yellow("Not built yet.")} ${
          dim("Run swamp app build in its folder.")
        }`,
      );
    }
    if (app.state !== "enabled" && !app.dev) {
      lines.push(dim(`  Enable it: swamp app approve ${safe(app.name)}`));
    }
  }
  for (const problem of data.problems) {
    lines.push(`${yellow("Unreadable:")} ${safe(problem.message)}`);
  }
  writeOutput(lines.join("\n"));
}

/** What an operator reads before an app is enabled. */
export function appApprovePrompt(app: AppSummary): {
  question: string;
  details: string[];
} {
  return {
    question: `Enable ${safe(app.name)}?`,
    details: [
      `${cyan("Asks for:")} ${grantLine(app)}`,
      yellow("This app can send anything it reads to external sites."),
    ],
  };
}

export function renderAppApproveCancelled(
  mode: OutputMode,
  name: string,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ name, approved: false }, null, 2));
    return;
  }
  writeOutput(dim(`${safe(name)} was not enabled.`));
}

export function renderAppApprove(
  mode: OutputMode,
  data: AppApproveData,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ ...data, approved: true }, null, 2));
    return;
  }
  writeOutput(
    [
      `${green("Enabled:")} ${bold(safe(data.name))}`,
      `  ${cyan("Asks for:")} ${grantLine(data)}`,
      yellow("  This app can send anything it reads to external sites."),
    ].join("\n"),
  );
}

export function renderAppRevoke(mode: OutputMode, data: AppRevokeData): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  writeOutput(
    data.revoked
      ? `${green("Disabled:")} ${bold(safe(data.name))}`
      : dim(`${safe(data.name)} was not enabled.`),
  );
}

export function renderAppInit(mode: OutputMode, data: AppInitData): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  writeOutput(
    [
      `${green("Created:")} ${bold(safe(data.name))} ${
        dim(`(${safe(data.directory)})`)
      }`,
      dim(
        `  Next: cd ${safe(data.directory)} && bun install, then swamp app dev`,
      ),
      dim("  With mise, run mise install first for the Bun mise.toml pins."),
    ].join("\n"),
  );
}

export function renderAppBuild(
  mode: OutputMode,
  data: {
    readonly name: string;
    readonly directory: string;
    /** Log mode already showed these through the logger, ahead of Vite. */
    readonly warnings?: readonly string[];
  },
): void {
  if (mode === "json") {
    const { warnings = [], ...rest } = data;
    console.log(
      JSON.stringify(
        { ...rest, built: true, ...(warnings.length > 0 ? { warnings } : {}) },
        null,
        2,
      ),
    );
    return;
  }
  writeOutput(`${green("Built:")} ${bold(safe(data.name))}`);
}

export function renderAppDevReady(
  mode: OutputMode,
  data: { readonly name: string; readonly url: string },
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data));
    return;
  }
  writeOutput(
    [
      `${green("Live:")} ${bold(safe(data.name))} ${dim(safe(data.url))}`,
      dim("  Open it under /apps in swamp dashboard. Press Ctrl-C to stop."),
    ].join("\n"),
  );
}
