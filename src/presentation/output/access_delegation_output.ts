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
import {
  escapeControlCharacters,
  escapeControlCharactersInText,
} from "../../domain/control_characters.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { DelegationEndData } from "../../libswamp/access/delegation_end.ts";
import type {
  DelegationListData,
  DelegationView,
} from "../../libswamp/access/delegation_list.ts";
import type { OutputMode } from "./output.ts";

function stateText(rawState: string): string {
  const state = escapeControlCharacters(rawState);
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
    line("Suspended since", escapeControlCharacters(view.hold.since)),
    ...view.hold.causes.map((cause) =>
      `  ${dim("because")} ${
        Object.hasOwn(HOLD_TEXT, cause)
          ? HOLD_TEXT[cause]
          : escapeControlCharacters(cause)
      }`
    ),
  ];
}

function relinkLines(view: DelegationView): string[] {
  const lines: string[] = [];
  if (view.mergedInto) {
    lines.push(
      line("Relinked into", bold(escapeControlCharacters(view.mergedInto))),
    );
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
        `${escapeControlCharacters(link.linkId)} ${
          link.endState === "pending"
            ? yellow(
              `(Swamp Club not told yet, ${
                escapeControlCharacters(String(link.endAttempts))
              } attempt(s))`,
            )
            : dim("(Swamp Club told it ended)")
        }`,
      ),
    );
    if (link.endState === "pending" && link.lastEndError) {
      lines.push(
        `  ${dim("last error:")} ${
          red(escapeControlCharactersInText(link.lastEndError))
        }`,
      );
    }
  }
  return lines;
}

function personText(view: DelegationView): string {
  const person = view.person;
  if (!person) return "";
  return escapeControlCharacters(
    person.username ? `${person.username} <${person.email}>` : person.email,
  );
}

function externalText(view: DelegationView): string {
  const { external } = view;
  if (!external.userId) return "";
  return escapeControlCharacters(
    `${external.display} (${external.platform}:${external.userId})`,
  );
}

function line(label: string, value: string): string {
  return `${bold(cyan(`${label}:`))} ${value}`;
}

function clubLines(view: DelegationView): string[] {
  const { club } = view;
  const lines: string[] = [];
  if (club.linkId) {
    lines.push(line("Swamp Club link", escapeControlCharacters(club.linkId)));
  }
  if (club.endState === "pending") {
    lines.push(
      line("Swamp Club", yellow("not told yet that this link ended")),
      `  ${dim("attempts:")} ${
        escapeControlCharacters(String(club.endAttempts))
      }`,
    );
    if (club.lastEndError) {
      lines.push(
        `  ${dim("last error:")} ${
          red(escapeControlCharactersInText(club.lastEndError))
        }`,
      );
    }
    if (club.nextEndAttemptAt) {
      lines.push(
        `  ${dim("next attempt:")} ${
          escapeControlCharacters(club.nextEndAttemptAt)
        }`,
      );
    }
  } else if (club.endState === "done") {
    lines.push(line("Swamp Club", "told this link ended"));
  }
  return lines;
}

function detailLines(view: DelegationView): string[] {
  const person = personText(view);
  const external = externalText(view);
  const esc = escapeControlCharacters;
  return [
    line("Delegation", bold(esc(view.id))),
    line("Integration", esc(view.integrationId)),
    line("State", stateText(view.state)),
    ...holdLines(view),
    ...(person ? [line("Person", person)] : []),
    ...(external
      ? [
        line("External user", external),
        `  ${dim("team:")} ${esc(view.external.teamId)}  ${dim("workspace:")} ${
          esc(view.external.workspace)
        }`,
      ]
      : []),
    ...(view.createdAt ? [line("Created", esc(view.createdAt))] : []),
    ...(view.consentedAt ? [line("Consented", esc(view.consentedAt))] : []),
    ...(view.expiresAt ? [line("Expires", esc(view.expiresAt))] : []),
    ...(view.endedAt ? [line("Ended", esc(view.endedAt))] : []),
    ...(view.endCause ? [line("End cause", esc(view.endCause))] : []),
    ...(view.refusalReason ? [line("Refused", esc(view.refusalReason))] : []),
    ...(view.tokenGeneration !== undefined
      ? [
        line(
          "Tokens",
          `generation ${esc(String(view.tokenGeneration))}${
            view.accessTokenExpiresAt
              ? `, access token expires ${esc(view.accessTokenExpiresAt)}`
              : ""
          }`,
        ),
      ]
      : []),
    ...(view.ceilingDigest
      ? [line("Ceiling", dim(esc(view.ceilingDigest)))]
      : []),
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
    lines.push(
      yellow(
        `Delegation ${escapeControlCharacters(view.id)} had already ended.`,
      ),
    );
  } else {
    lines.push(
      `${green("✓")} Delegation ${
        bold(escapeControlCharacters(view.id))
      } ended.`,
    );
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
  const rows = data.delegations.map((view) =>
    [
      view.id,
      view.integrationId,
      view.state,
      personText(view),
      externalText(view),
      view.expiresAt ?? "",
    ].map(escapeControlCharacters)
  );
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
