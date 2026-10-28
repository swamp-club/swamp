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

import type { InboxNotice } from "../domain/inbox/inbox_policy.ts";
import type { InboxPoll } from "../libswamp/inbox/notice.ts";
import type { OutputMode } from "../presentation/output/output.ts";
import { renderInboxNotice } from "../presentation/renderers/inbox_notice.ts";
import type { AuthGateTiming } from "./auth_gate_exemptions.ts";
import { behaviorTwinPath } from "./behavior_twin.ts";
import { postCommandNoticesAllowed } from "./context.ts";

/**
 * Which runs poll the inbox and which print the inbox notice
 * (design/surfaces/inbox.md, "How the CLI uses it"). Every decision here is
 * made from the command path resolved against the real command tree, never
 * from raw argument positions, so the `behavior` and `model` spellings of a
 * command decide alike.
 */

/** The slow commands that poll, as `swamp model` paths. */
const POLLING_COMMANDS: readonly (readonly string[])[] = [
  ["workflow", "run"],
  ["model", "method", "run"],
  ["extension", "pull"],
  ["extension", "push"],
];

/**
 * Command groups that never show the notice: the inbox itself, the
 * subscription and the path to a credential, and the long-running commands
 * whose stderr nobody reads.
 */
const NOTICE_EXCLUDED_GROUPS: ReadonlySet<string> = new Set([
  "inbox",
  "subscription",
  "auth",
  "serve",
  "worker",
  "start",
  "dashboard",
]);

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, i) => word === b[i]);
}

/** Whether a run of this command polls the inbox in the background. */
export function pollsInbox(commandPath: readonly string[]): boolean {
  const path = behaviorTwinPath(commandPath);
  return POLLING_COMMANDS.some((polling) => samePath(polling, path));
}

/** Whether this command may print the inbox notice after it finishes. */
export function showsInboxNotice(
  commandPath: readonly string[],
  gateTiming: AuthGateTiming,
): boolean {
  if (gateTiming !== "gated") return false;
  const root = commandPath[0];
  return root !== undefined && !NOTICE_EXCLUDED_GROUPS.has(root);
}

function switchedOn(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" &&
    value !== "false";
}

/**
 * True when `CI` or `SWAMP_NO_INBOX_NOTICE` is set to anything but an empty
 * string, `0` or `false`, as `SWAMP_NO_UPDATE_CHECK` is read. Either turns
 * off both the poll and the notice.
 */
export function inboxNoticeDisabledByEnv(
  get: (name: string) => string | undefined = (name) => Deno.env.get(name),
): boolean {
  return switchedOn(get("CI")) || switchedOn(get("SWAMP_NO_INBOX_NOTICE"));
}

export interface InboxNoticeRun {
  readonly commandPath: readonly string[];
  readonly gateTiming: AuthGateTiming;
  /** Whether the auth gate passed this run on its own credential. */
  readonly gatePassed: boolean;
  /** Whether a swamp above this process started it. */
  readonly nested: boolean;
  readonly disabledByEnv: boolean;
}

export interface InboxNoticeEligibility {
  readonly poll: boolean;
  readonly notice: boolean;
}

/**
 * What this run does with the inbox. A nested run (a swamp started by a
 * workflow step or a shell behavior) does neither, so it never polls again
 * or prints the notice into the output its parent captures; the outermost
 * run does both.
 */
export function inboxNoticeEligibility(
  run: InboxNoticeRun,
): InboxNoticeEligibility {
  if (!run.gatePassed || run.nested || run.disabledByEnv) {
    return { poll: false, notice: false };
  }
  const notice = showsInboxNotice(run.commandPath, run.gateTiming);
  return { poll: notice && pollsInbox(run.commandPath), notice };
}

export interface FinishInboxNoticeOptions {
  readonly poll: InboxPoll | null;
  /** Whether this run may print the notice at all. */
  readonly notice: boolean;
  readonly outputMode: OutputMode;
  readonly quiet: boolean;
  /** False on the error path: a failed command's output ends with its error. */
  readonly succeeded: boolean;
  readonly show: () => Promise<InboxNotice | null>;
  readonly write?: (line: string) => void;
}

/**
 * The inbox's part of teardown. Always settles and saves the poll, then
 * prints the notice only after a command that succeeded, in log mode without
 * `-q`. Never throws.
 */
export async function finishInboxNotice(
  options: FinishInboxNoticeOptions,
): Promise<void> {
  try {
    await options.poll?.settle();
    if (
      !options.succeeded || !options.notice ||
      !postCommandNoticesAllowed(options.outputMode, options.quiet)
    ) {
      return;
    }
    const notice = await options.show();
    if (notice !== null) renderInboxNotice(notice, options.write);
  } catch {
    // Best effort — the inbox never changes how a run ends.
  }
}
