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
// the hub sent these strings; log mode escapes them, JSON.stringify escapes JSON
import { escapeControlCharacters as shown } from "../../domain/control_characters.ts";
import type {
  HubLinkInstance,
  HubLinkState,
  HubLinkView,
} from "../../domain/serve/hub_link.ts";
import type { HubForgetData } from "../../libswamp/serve/hub_forget.ts";
import type { OutputMode } from "./output.ts";

function key(label: string): string {
  return bold(cyan(`${label}:`));
}

function json(data: unknown): void {
  // deno-lint-ignore no-console
  console.log(JSON.stringify(data, null, 2));
}

function colorState(state: HubLinkState): string {
  switch (state) {
    case "joined":
      return green(state);
    case "joining":
    case "unjoined":
      return yellow(state);
    case "refused":
    case "mismatched":
      return red(state);
  }
}

const STATE_HINTS: Record<HubLinkState, string | undefined> = {
  joined: undefined,
  joining: "A join is in flight; check again shortly.",
  unjoined:
    "Not joined: set federation.join-token-file in serve.yaml to a token minted on the hub, then restart serve.",
  refused:
    "The hub removed this serve or revoked its credential; set a new join-token-file and restart serve to join again.",
  mismatched:
    "serve.yaml names another hub; this serve stays joined to the first. Run swamp serve hub forget --yes with serve stopped to leave it.",
};

function instanceLine(instance: HubLinkInstance): string {
  const status = instance.stoppedAt !== null
    ? dim(`stopped ${shown(instance.stoppedAt)}`)
    : instance.result === "ok"
    ? green(`ok, last check-in ${shown(String(instance.lastSuccessAt))}`)
    : instance.result === null && instance.lastAttemptAt === null
    ? dim("no check-in yet")
    : yellow(
      `${shown(instance.result ?? "no reply yet")}${
        instance.consecutiveFailures === 1
          ? " (1 failure)"
          : instance.consecutiveFailures > 1
          ? ` (${instance.consecutiveFailures} failures)`
          : ""
      }${
        instance.lastAttemptAt !== null
          ? `, last attempt ${shown(instance.lastAttemptAt)}`
          : ""
      }${
        instance.nextAttemptAt !== null
          ? `, next attempt ${shown(instance.nextAttemptAt)}`
          : ""
      }`,
    );
  return `  ${shown(instance.instanceId)}  ${status}`;
}

export function renderHubLink(
  data: { link: HubLinkView },
  mode: OutputMode,
): void {
  if (mode === "json") return json(data);
  const link = data.link;
  const lines = [
    `${key("Hub")} ${shown(link.hubUrl ?? link.configuredHubUrl)}${
      link.hubName !== null ? ` (${bold(shown(link.hubName))})` : ""
    }`,
  ];
  if (link.hubUrl !== null && link.hubUrl !== link.configuredHubUrl) {
    lines.push(`${key("serve.yaml names")} ${shown(link.configuredHubUrl)}`);
  }
  lines.push(`${key("State")} ${colorState(link.state)}`);
  if (link.memberName !== null) {
    lines.push(
      `${key("Member")} ${bold(shown(link.memberName))} ${
        dim(shown(link.memberId ?? ""))
      }`,
    );
  }
  if (link.joinedAt !== null) {
    lines.push(`${key("Joined")} ${shown(link.joinedAt)}`);
  }
  lines.push(key("Instances"));
  if (link.instances.length === 0) lines.push(dim("  none"));
  for (const instance of link.instances) lines.push(instanceLine(instance));
  const hint = STATE_HINTS[link.state];
  if (hint !== undefined) lines.push("", dim(hint));
  writeOutput(lines.join("\n"));
}

export function renderHubForget(data: HubForgetData, mode: OutputMode): void {
  if (mode === "json") return json(data);
  if (!data.forgot) {
    writeOutput(dim("This serve had no hub link to forget."));
    return;
  }
  writeOutput([
    `${green("✓")} Forgot the link to ${
      data.hubUrl === null ? "its hub" : shown(data.hubUrl)
    }${
      data.memberName !== null ? ` as ${bold(shown(data.memberName))}` : ""
    }, and its credential.`,
    dim(
      "Set federation.hub and a join-token-file in serve.yaml, then start serve, to join a hub again.",
    ),
  ].join("\n"));
}
