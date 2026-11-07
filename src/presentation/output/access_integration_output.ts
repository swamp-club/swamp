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
import { Ceiling } from "../../domain/access/ceiling.ts";
import { maxOf } from "../../domain/array_extrema.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type {
  IntegrationListData,
  IntegrationView,
} from "../../libswamp/access/integration_list.ts";
import type { OutputMode } from "./output.ts";

function stateText(state: string): string {
  return state === "active" ? green(state) : red(state);
}

function ceilingLines(ceiling: unknown): string[] {
  let document;
  try {
    document = Ceiling.parse(ceiling).toDocument();
  } catch {
    return [`  ${dim("(this build can't read it)")}`];
  }
  if (document.ceiling.length === 0) {
    return [`  ${dim("(empty: allows nothing)")}`];
  }
  const width = maxOf(document.ceiling.map((e) => e.resource.length))!;
  return document.ceiling.map((entry) =>
    `  ${entry.resource.padEnd(width)}  ${entry.actions.join(", ")}`
  );
}

function detailLines(view: IntegrationView): string[] {
  return [
    `${bold(cyan("Integration:"))} ${bold(view.id)}`,
    `${bold(cyan("Name:"))} ${view.name}`,
    `${bold(cyan("State:"))} ${stateText(view.state)}`,
    `${bold(cyan("Client:"))} integration:${view.id}`,
    `${bold(cyan("Created:"))} ${view.createdAt}`,
    ...(view.ceilingChangedAt
      ? [`${bold(cyan("Ceiling changed:"))} ${view.ceilingChangedAt}`]
      : []),
    ...(view.revokedAt ? [`${bold(cyan("Revoked:"))} ${view.revokedAt}`] : []),
    `${bold(cyan("Ceiling:"))} ${dim(view.ceilingDigest)}`,
    ...ceilingLines(view.ceiling),
  ];
}

export function renderIntegrationRegistered(
  view: IntegrationView,
  credential: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    // Secret goes directly to stdout — never through the logger.
    console.log(JSON.stringify({ ...view, credential }, null, 2));
    return;
  }
  writeOutput(detailLines(view).join("\n"));
  writeOutput(`${bold(cyan("Credential:"))}`);
  console.log(`\n  ${bold(credential)}\n`);
  writeOutput(
    yellow(
      "This is the only time it is shown. Store it securely: only its hash is kept.",
    ),
  );
}

export function renderIntegration(
  view: IntegrationView,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  writeOutput(detailLines(view).join("\n"));
}

export function renderIntegrationCeilingChanged(
  view: IntegrationView,
  mode: OutputMode,
): void {
  if (mode !== "json") {
    writeOutput(`${green("✓")} Ceiling of ${bold(view.id)} changed.`);
  }
  renderIntegration(view, mode);
}

export function renderIntegrationRevoked(
  view: IntegrationView,
  alreadyRevoked: boolean,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ ...view, alreadyRevoked }, null, 2));
    return;
  }
  writeOutput(
    alreadyRevoked
      ? yellow(`Integration ${view.id} was already revoked.`)
      : `${green("✓")} Integration ${bold(view.id)} revoked.`,
  );
  writeOutput(detailLines(view).join("\n"));
}

export function renderIntegrationList(
  data: IntegrationListData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data.integrations, null, 2));
    return;
  }
  if (data.integrations.length === 0) {
    writeOutput(
      [
        "No integrations registered.",
        dim(
          "Register one with: swamp access integration register <id> --name <name> --ceiling 'run,read=workflow:<name>'",
        ),
      ].join("\n"),
    );
    return;
  }
  const rows = data.integrations.map((view) => [
    view.id,
    view.state,
    view.name,
    view.createdAt,
  ]);
  const headers = ["ID", "STATE", "NAME", "CREATED"];
  const widths = headers.map((header, i) =>
    maxOf([header.length, ...rows.map((row) => row[i].length)])!
  );
  writeOutput(
    [
      dim(headers.map((header, i) => header.padEnd(widths[i])).join("  ")),
      ...rows.map((row) =>
        row.map((cell, i) => {
          const padded = cell.padEnd(widths[i]);
          return i === 1 ? padded.replace(cell, stateText(cell)) : padded;
        }).join("  ").trimEnd()
      ),
    ].join("\n"),
  );
}
