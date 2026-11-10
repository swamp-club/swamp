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
import { maxOf } from "../../domain/array_extrema.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { DelegationEndData } from "../../libswamp/access/delegation_end.ts";
import type {
  DelegationListData,
  DelegationView,
} from "../../libswamp/access/delegation_list.ts";
import type { OutputMode } from "./output.ts";

function stateText(state: string): string {
  if (state === "issued" || state === "consented") return green(state);
  if (
    state === "awaiting_consent" || state === "reporting" ||
    state === "suspended"
  ) {
    return yellow(state);
  }
  return red(state);
}

const HOLD_TEXT: Record<string, string> = {
  person_suspended: "the person is suspended on Swamp Club",
  club_client_refused: "Swamp Club refuses this serve's client",
  club_unknown: "Swamp Club no longer knows this link",
};

function holdLines(view: DelegationView): string[] {
  if (!view.hold) return [];
  return [
    line("Suspended since", view.hold.since),
    ...view.hold.causes.map((cause) =>
      `  ${dim("because")} ${HOLD_TEXT[cause] ?? cause}`
    ),
  ];
}

function relinkLines(view: DelegationView): string[] {
  const lines: string[] = [];
  if (view.mergedInto) {
    lines.push(line("Relinked into", bold(view.mergedInto)));
  }
  if (view.relinkPending) {
    lines.push(
      line("Relink", yellow("consented, not yet redeemed by the app")),
    );
  }
  for (const link of view.retiredLinks ?? []) {
    lines.push(
      line(
        "Replaced link",
        `${link.linkId} ${
          link.endState === "pending"
            ? yellow(
              `(Swamp Club not told yet, ${link.endAttempts} attempt(s))`,
            )
            : dim("(Swamp Club told it ended)")
        }`,
      ),
    );
    if (link.endState === "pending" && link.lastEndError) {
      lines.push(`  ${dim("last error:")} ${red(link.lastEndError)}`);
    }
  }
  return lines;
}

function personText(view: DelegationView): string {
  const person = view.person;
  if (!person) return "";
  return person.username
    ? `${person.username} <${person.email}>`
    : person.email;
}

function externalText(view: DelegationView): string {
  const { external } = view;
  if (!external.userId) return "";
  return `${external.display} (${external.platform}:${external.userId})`;
}

function line(label: string, value: string): string {
  return `${bold(cyan(`${label}:`))} ${value}`;
}

function clubLines(view: DelegationView): string[] {
  const { club } = view;
  const lines: string[] = [];
  if (club.linkId) lines.push(line("Swamp Club link", club.linkId));
  if (club.endState === "pending") {
    lines.push(
      line("Swamp Club", yellow("not told yet that this link ended")),
      `  ${dim("attempts:")} ${club.endAttempts}`,
    );
    if (club.lastEndError) {
      lines.push(`  ${dim("last error:")} ${red(club.lastEndError)}`);
    }
    if (club.nextEndAttemptAt) {
      lines.push(`  ${dim("next attempt:")} ${club.nextEndAttemptAt}`);
    }
  } else if (club.endState === "done") {
    lines.push(line("Swamp Club", "told this link ended"));
  }
  return lines;
}

function detailLines(view: DelegationView): string[] {
  const person = personText(view);
  const external = externalText(view);
  return [
    line("Delegation", bold(view.id)),
    line("Integration", view.integrationId),
    line("State", stateText(view.state)),
    ...holdLines(view),
    ...(person ? [line("Person", person)] : []),
    ...(external
      ? [
        line("External user", external),
        `  ${dim("team:")} ${view.external.teamId}  ${
          dim("workspace:")
        } ${view.external.workspace}`,
      ]
      : []),
    ...(view.createdAt ? [line("Created", view.createdAt)] : []),
    ...(view.consentedAt ? [line("Consented", view.consentedAt)] : []),
    ...(view.expiresAt ? [line("Expires", view.expiresAt)] : []),
    ...(view.endedAt ? [line("Ended", view.endedAt)] : []),
    ...(view.endCause ? [line("End cause", view.endCause)] : []),
    ...(view.refusalReason ? [line("Refused", view.refusalReason)] : []),
    ...(view.tokenGeneration !== undefined
      ? [
        line(
          "Tokens",
          `generation ${view.tokenGeneration}${
            view.accessTokenExpiresAt
              ? `, access token expires ${view.accessTokenExpiresAt}`
              : ""
          }`,
        ),
      ]
      : []),
    ...(view.ceilingDigest ? [line("Ceiling", dim(view.ceilingDigest))] : []),
    ...clubLines(view),
    ...relinkLines(view),
  ];
}

export function renderDelegation(view: DelegationView, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  writeOutput(detailLines(view).join("\n"));
}

export function renderDelegationEnded(
  data: DelegationEndData,
  mode: OutputMode,
): void {
  const view = data.delegation;
  if (mode === "json") {
    console.log(
      JSON.stringify({ ...view, alreadyEnded: data.alreadyEnded }, null, 2),
    );
    return;
  }
  const lines: string[] = [];
  if (data.alreadyEnded) {
    lines.push(yellow(`Delegation ${view.id} had already ended.`));
  } else {
    lines.push(`${green("✓")} Delegation ${bold(view.id)} ended.`);
    if (view.club.endState === "pending") {
      lines.push(
        dim(
          "The serve leader will tell swamp-club, which then stops showing the link.",
        ),
      );
    }
  }
  writeOutput(lines.join("\n"));
  writeOutput(detailLines(view).join("\n"));
}

export function renderDelegationList(
  data: DelegationListData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data.delegations, null, 2));
    return;
  }
  if (data.delegations.length === 0) {
    writeOutput("No delegations.");
    return;
  }
  const rows = data.delegations.map((view) => [
    view.id,
    view.integrationId,
    view.state,
    personText(view),
    externalText(view),
    view.expiresAt ?? "",
  ]);
  const headers = [
    "ID",
    "INTEGRATION",
    "STATE",
    "PERSON",
    "EXTERNAL USER",
    "EXPIRES",
  ];
  const widths = headers.map((header, i) =>
    maxOf([header.length, ...rows.map((row) => row[i].length)])!
  );
  writeOutput(
    [
      dim(headers.map((header, i) => header.padEnd(widths[i])).join("  ")),
      ...rows.map((row) =>
        row.map((cell, i) => {
          const padded = cell.padEnd(widths[i]);
          return i === 2 ? padded.replace(cell, stateText(cell)) : padded;
        }).join("  ").trimEnd()
      ),
    ].join("\n"),
  );
}
