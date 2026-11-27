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
// another serve may have supplied these strings, so log mode escapes them
import { escapeControlCharacters as shown } from "../../domain/control_characters.ts";
import type { MemberData } from "../../libswamp/serve/member_get.ts";
import {
  type Liveness,
  livenessFor,
  type ServeMemberRecord,
} from "../../domain/serve/serve_member.ts";
import type { MemberLiveView } from "../../domain/serve/member_live_view.ts";
import type { FingerprintRuntime } from "../../domain/serve/fingerprint.ts";
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

// a serve from before the live view answers without it, so it may be missing
type ReportedMember = ServeMemberRecord & { readonly live?: MemberLiveView };

const UNITS: readonly [string, number][] = [
  ["d", 24 * 60 * 60 * 1000],
  ["h", 60 * 60 * 1000],
  ["m", 60 * 1000],
  ["s", 1000],
];

/** the largest whole unit: 2d, not 50h 3m 2s */
function largestUnit(ms: number): string {
  for (const [unit, size] of UNITS) {
    if (ms >= size) return `${Math.floor(ms / size)}${unit}`;
  }
  return "0s";
}

function lastSeen(iso: string | null, now: number): string {
  if (iso === null) return "-";
  const ageMs = now - Date.parse(iso);
  if (Number.isNaN(ageMs)) return "-";
  if (Math.abs(ageMs) < 1000) return "just now";
  return ageMs < 0 ? `in ${largestUnit(-ageMs)}` : `${largestUnit(ageMs)} ago`;
}

// the hub's clock, so the CLI's own clock skew never shows; a serve that predates now falls back to ours
function clockOf(data: { readonly now?: string }, fallback: number): number {
  const hubNow = data.now === undefined ? NaN : Date.parse(data.now);
  return Number.isNaN(hubNow) ? fallback : hubNow;
}

// a check-in time that does not parse is never shown as running
function livenessAt(iso: string, now: number): Liveness {
  const ageMs = now - Date.parse(iso);
  return Number.isNaN(ageMs) ? "offline" : livenessFor(ageMs);
}

function liveInstanceCount(member: ReportedMember, now: number): string {
  if (member.live === undefined) return "-";
  return String(
    member.live.instances.filter((instance) =>
      livenessAt(instance.lastSeenAt, now) === "live"
    ).length,
  );
}

function runtimeFacts(runtime: FingerprintRuntime | null): string {
  if (runtime === null) return "no runtime reported";
  const team = runtime.team === null
    ? "no team"
    : `${shown(runtime.team.role)} of ${runtime.team.nodes}`;
  const started = runtime.startedAt === null
    ? "start unknown"
    : `started ${shown(runtime.startedAt)}`;
  const ready = runtime.ready === null
    ? "readiness unknown"
    : runtime.ready
    ? "ready"
    : "not ready";
  return `${team}, ${started}, ${ready}`;
}

function colorState(state: string): string {
  switch (state) {
    case "unused":
    case "online":
    case "live":
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
  data: { readonly members: readonly ReportedMember[]; readonly now?: string },
  mode: OutputMode,
  localNow: number = Date.now(),
): void {
  if (mode === "json") return json(data);
  const now = clockOf(data, localNow);
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
      ["NAME", "ROLE", "STATUS", "LAST SEEN", "INSTANCES", "SWAMP", "JOINED"],
      data.members.map((member) => [
        shown(member.name),
        shown(member.role),
        shown(member.status),
        lastSeen(member.live?.lastSeenAt ?? null, now),
        liveInstanceCount(member, now),
        shown(member.fingerprint.swampVersion),
        shown(member.joinedAt),
      ]),
      (column, value) => column === 2 ? colorState(value) : value,
    ).join("\n"),
  );
}

export function renderMemberGet(
  data: { readonly member: ReportedMember; readonly now?: string },
  mode: OutputMode,
  localNow: number = Date.now(),
): void {
  if (mode === "json") return json(data);
  const now = clockOf(data, localNow);
  const member = data.member;
  const f = member.fingerprint;
  const lines = [
    `${key("Member")} ${bold(shown(member.name))} ${
      dim(`(${shown(member.role)})`)
    }`,
    `${key("Status")} ${colorState(shown(member.status))}`,
    `${key("Member id")} ${shown(member.memberId)}`,
    `${key("Joined")} ${shown(member.joinedAt)}`,
  ];
  if (member.removedAt !== undefined) {
    lines.push(`${key("Removed")} ${shown(member.removedAt)}`);
  }
  lines.push("");
  lines.push(cyan("Fingerprint:"));
  lines.push(`  ${key("Swamp version")} ${shown(f.swampVersion)}`);
  lines.push(`  ${key("Platform")} ${shown(f.platform)}/${shown(f.arch)}`);
  lines.push(`  ${key("Mode")} ${shown(f.deploymentMode)}`);
  lines.push(
    `  ${key("Datastore")} ${shown(f.datastoreKind)} ${
      dim(`(${shown(f.datastoreFormat)})`)
    }`,
  );
  lines.push(`  ${key("Auth mode")} ${shown(f.authMode)}`);
  lines.push("");
  lines.push(cyan("Instances:"));
  if (member.instances.length === 0) {
    lines.push(`  ${dim("none")}`);
  }
  for (const instance of member.instances) {
    lines.push(
      `  ${shown(instance.instanceId)} ${
        dim(
          `(swamp ${shown(instance.swampVersion)}, first seen ${
            shown(instance.firstSeen)
          })`,
        )
      }`,
    );
  }
  // check-ins come from the control-plane store, apart from the record above
  lines.push("");
  lines.push(cyan("Live:"));
  const live = member.live;
  if (live === undefined) {
    lines.push(`  ${dim("not reported by this server")}`);
    writeOutput(lines.join("\n"));
    return;
  }
  lines.push(
    `  ${key("Last seen")} ${lastSeen(live.lastSeenAt, now)}${
      live.lastSeenAt === null ? "" : dim(` (${shown(live.lastSeenAt)})`)
    }`,
  );
  for (const instance of live.instances) {
    const state = livenessAt(instance.lastSeenAt, now);
    const facts = state === "live"
      ? ` ${dim(`(${runtimeFacts(instance.runtime)})`)}`
      : "";
    lines.push(
      `  ${shown(instance.instanceId)} ${colorState(state)} ${
        lastSeen(instance.lastSeenAt, now)
      }${facts}`,
    );
  }
  writeOutput(lines.join("\n"));
}

export function renderMemberRemove(data: MemberData, mode: OutputMode): void {
  if (mode === "json") return json(data);
  writeOutput([
    `${green(checkmark)} Member ${bold(shown(data.member.name))} removed.`,
    dim(
      "Its credential no longer checks in; the record is kept, marked removed.",
    ),
  ].join("\n"));
}
