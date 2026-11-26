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
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { maxOf } from "../../domain/array_extrema.ts";
import type { MemberListData } from "../../libswamp/serve/member_list.ts";
import type { MemberData } from "../../libswamp/serve/member_get.ts";
import type { MemberTokenCreateData } from "../../libswamp/serve/member_token_create.ts";
import type { MemberTokenListData } from "../../libswamp/serve/member_token_list.ts";
import type { MemberTokenRevokeData } from "../../libswamp/serve/member_token_revoke.ts";
import type { OutputMode } from "./output.ts";

const checkmark = "✓";

function key(label: string): string {
  return bold(cyan(`${label}:`));
}

function json(data: unknown): void {
  // deno-lint-ignore no-console
  console.log(JSON.stringify(data, null, 2));
}

function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  color: (column: number, value: string) => string = (_c, v) => v,
): string[] {
  const widths = headers.map((header, column) =>
    maxOf([header.length, ...rows.map((row) => row[column].length)])!
  );
  const line = (cells: readonly string[], paint: typeof color) =>
    cells.map((cell, column) =>
      column === cells.length - 1
        ? paint(column, cell)
        : paint(column, cell) + " ".repeat(widths[column] - cell.length)
    ).join("  ");
  return [
    line(headers, (_c, v) => bold(v)),
    ...rows.map((row) => line(row, color)),
  ];
}

function colorState(state: string): string {
  switch (state) {
    case "unused":
    case "online":
      return green(state);
    case "stale":
      return yellow(state);
    case "revoked":
    case "removed":
    case "offline":
      return red(state);
    default:
      return dim(state);
  }
}

export function renderMemberTokenCreate(
  data: MemberTokenCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") return json(data);
  writeOutput([
    `${key("Join token")} ${bold(data.token.memberName)}`,
    `${key("Expires")} ${data.token.expiresAt}`,
    "",
    `  ${bold(data.joinToken)}`,
    "",
    yellow(
      "This token is shown once and will not be displayed again; the hub keeps only its hash.",
    ),
    dim(
      "Give it to the member's operator; it joins once, as the name it was minted for.",
    ),
  ].join("\n"));
}

export function renderMemberTokenList(
  data: MemberTokenListData,
  mode: OutputMode,
): void {
  if (mode === "json") return json(data);
  if (data.tokens.length === 0) {
    writeOutput([
      "No join tokens found.",
      dim("Mint one with: swamp serve member token create <name>"),
    ].join("\n"));
    return;
  }
  writeOutput(
    table(
      ["NAME", "STATE", "EXPIRES", "USED"],
      data.tokens.map((token) => [
        token.memberName,
        token.state,
        token.expiresAt,
        token.usedAt ?? "-",
      ]),
      (column, value) => column === 1 ? colorState(value) : value,
    ).join("\n"),
  );
}

export function renderMemberTokenRevoke(
  data: MemberTokenRevokeData,
  mode: OutputMode,
): void {
  if (mode === "json") return json(data);
  writeOutput(
    `${green(checkmark)} Join token ${bold(data.token.memberName)} revoked.`,
  );
}

export function renderMemberList(
  data: MemberListData,
  mode: OutputMode,
): void {
  if (mode === "json") return json(data);
  if (data.members.length === 0) {
    writeOutput([
      "No members found.",
      dim(
        "A member appears once it joins with a token from: swamp serve member token create <name>",
      ),
    ].join("\n"));
    return;
  }
  writeOutput(
    table(
      ["NAME", "ROLE", "STATUS", "INSTANCES", "SWAMP", "JOINED"],
      data.members.map((member) => [
        member.name,
        member.role,
        member.status,
        String(member.instances.length),
        member.fingerprint.swampVersion,
        member.joinedAt,
      ]),
      (column, value) => column === 2 ? colorState(value) : value,
    ).join("\n"),
  );
}

export function renderMemberGet(data: MemberData, mode: OutputMode): void {
  if (mode === "json") return json(data);
  const member = data.member;
  const f = member.fingerprint;
  const lines = [
    `${key("Member")} ${bold(member.name)} ${dim(`(${member.role})`)}`,
    `${key("Status")} ${colorState(member.status)}`,
    `${key("Member id")} ${member.memberId}`,
    `${key("Joined")} ${member.joinedAt}`,
  ];
  if (member.removedAt !== undefined) {
    lines.push(`${key("Removed")} ${member.removedAt}`);
  }
  lines.push("");
  lines.push(cyan("Fingerprint:"));
  lines.push(`  ${key("Swamp version")} ${f.swampVersion}`);
  lines.push(`  ${key("Platform")} ${f.platform}/${f.arch}`);
  lines.push(`  ${key("Mode")} ${f.deploymentMode}`);
  lines.push(
    `  ${key("Datastore")} ${f.datastoreKind} ${dim(`(${f.datastoreFormat})`)}`,
  );
  lines.push(`  ${key("Auth mode")} ${f.authMode}`);
  lines.push("");
  lines.push(cyan("Instances:"));
  if (member.instances.length === 0) {
    lines.push(`  ${dim("none")}`);
  }
  for (const instance of member.instances) {
    lines.push(
      `  ${instance.instanceId} ${
        dim(
          `(swamp ${instance.swampVersion}, first seen ${instance.firstSeen})`,
        )
      }`,
    );
  }
  writeOutput(lines.join("\n"));
}

export function renderMemberRemove(data: MemberData, mode: OutputMode): void {
  if (mode === "json") return json(data);
  writeOutput([
    `${green(checkmark)} Member ${bold(data.member.name)} removed.`,
    dim(
      "Its credential no longer checks in; the record is kept, marked removed.",
    ),
  ].join("\n"));
}
