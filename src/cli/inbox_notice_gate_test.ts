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

import { assertEquals } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import {
  LockHolderMarker,
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_PID,
} from "../domain/datastore/lock_holder_marker.ts";
import type { InboxNotice } from "../domain/inbox/inbox_policy.ts";
import { NESTED_SWAMP_ENV_VARS } from "../domain/remote/environment_snapshot.ts";
import type { InboxPoll } from "../libswamp/inbox/notice.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";
import { rewriteDirectTypeArgs } from "./arg_rewriter.ts";
import { authGateTiming } from "./auth_gate_exemptions.ts";
import {
  commandSucceeded,
  finishInboxNotice,
  type FinishInboxNoticeOptions,
  inboxNoticeDisabledByEnv,
  type InboxNoticeEligibility,
  inboxNoticeEligibility,
  pollsInbox,
} from "./inbox_notice_gate.ts";
import { buildCommandTree } from "./mod.ts";
import { resolveTelemetryInvocation } from "./telemetry_invocation.ts";

const tree = buildCommandTree();

/** What a run of `args` does with the inbox, resolved as runCli resolves it. */
function eligibility(
  args: string[],
  overrides: { gatePassed?: boolean; nested?: boolean; disabled?: boolean } =
    {},
): InboxNoticeEligibility {
  const rewritten = rewriteDirectTypeArgs(args);
  return inboxNoticeEligibility({
    commandPath:
      resolveTelemetryInvocation(tree, [...rewritten], []).commandPath ?? [],
    gateTiming: authGateTiming(tree, rewritten),
    gatePassed: overrides.gatePassed ?? true,
    nested: overrides.nested ?? false,
    disabledByEnv: overrides.disabled ?? false,
  });
}

const BOTH = { poll: true, notice: true };
const NOTICE_ONLY = { poll: false, notice: true };
const NEITHER = { poll: false, notice: false };

Deno.test("inboxNoticeEligibility: the slow commands poll in every spelling", () => {
  for (
    const args of [
      ["workflow", "run", "deploy"],
      ["--json", "workflow", "run", "deploy"],
      ["model", "method", "run", "my-model", "sync"],
      ["behavior", "run", "my-model", "sync"],
      ["behaviour", "run", "my-model", "sync"],
      ["model", "@swamp/issue-lifecycle", "method", "run", "start", "x"],
      ["behavior", "run", "@swamp/issue-lifecycle", "start", "issue-1"],
      ["extension", "pull", "@swamp/aws-ec2"],
      ["extension", "push", "manifest.yaml"],
    ]
  ) {
    assertEquals(eligibility(args), BOTH, args.join(" "));
  }
});

Deno.test("inboxNoticeEligibility: fast commands show the notice from the cache without polling", () => {
  for (
    const args of [
      ["data", "list"],
      ["model", "get", "my-model"],
      ["behavior", "get", "my-model"],
      ["behavior", "describe", "my-model", "sync"],
      ["model", "method", "describe", "my-model", "sync"],
      ["workflow", "get", "deploy"],
      ["extension", "list"],
      ["vault", "list"],
    ]
  ) {
    assertEquals(eligibility(args), NOTICE_ONLY, args.join(" "));
  }
});

Deno.test("inboxNoticeEligibility: excluded and gate-exempt commands never poll or show", () => {
  for (
    const args of [
      ["inbox"],
      ["inbox", "read"],
      ["subscription", "status"],
      ["auth", "whoami"],
      ["auth", "login"],
      ["serve"],
      ["worker", "connect"],
      ["worker", "exec-dispatch"],
      ["start"],
      ["dashboard"],
      ["help", "workflow"],
      ["version"],
      ["update"],
      ["completions", "zsh"],
      ["workflow", "run", "--help"],
      ["behavior", "run", "-h"],
      [],
    ]
  ) {
    assertEquals(eligibility(args), NEITHER, args.join(" "));
  }
});

Deno.test("inboxNoticeEligibility: a nested run, a blocked gate or the env switch turns off both", () => {
  const args = ["workflow", "run", "deploy"];
  assertEquals(eligibility(args, { nested: true }), NEITHER);
  assertEquals(eligibility(args, { gatePassed: false }), NEITHER);
  assertEquals(eligibility(args, { disabled: true }), NEITHER);
});

Deno.test("pollsInbox: only the four slow commands poll", () => {
  assertEquals(pollsInbox(["workflow", "run"]), true);
  assertEquals(pollsInbox(["behavior", "run"]), true);
  assertEquals(pollsInbox(["model", "method", "run"]), true);
  assertEquals(pollsInbox(["extension", "pull"]), true);
  assertEquals(pollsInbox(["extension", "push"]), true);
  assertEquals(pollsInbox(["workflow"]), false);
  assertEquals(pollsInbox(["workflow", "run", "extra"]), false);
  assertEquals(pollsInbox(["extension", "install"]), false);
  assertEquals(pollsInbox([]), false);
});

Deno.test("inboxNoticeDisabledByEnv: CI and SWAMP_NO_INBOX_NOTICE switch off unless empty, 0 or false", () => {
  for (const name of ["CI", "SWAMP_NO_INBOX_NOTICE"]) {
    for (const value of ["1", "true", "yes", "anything"]) {
      assertEquals(
        withMockedEnv(
          { CI: undefined, SWAMP_NO_INBOX_NOTICE: undefined, [name]: value },
          () => inboxNoticeDisabledByEnv(),
        ),
        true,
        `${name}=${value}`,
      );
    }
    for (const value of ["", "0", "false", undefined]) {
      assertEquals(
        withMockedEnv(
          { CI: undefined, SWAMP_NO_INBOX_NOTICE: undefined, [name]: value },
          () => inboxNoticeDisabledByEnv(),
        ),
        false,
        `${name}=${value}`,
      );
    }
  }
});

interface FinishRecorder {
  lines: string[];
  shows: number;
  settles: number;
}

async function finish(
  overrides: Partial<FinishInboxNoticeOptions>,
  notice: InboxNotice | null = { unread: 1 },
): Promise<FinishRecorder> {
  const rec: FinishRecorder = { lines: [], shows: 0, settles: 0 };
  const poll: InboxPoll = {
    settle: () => {
      rec.settles++;
      return Promise.resolve();
    },
  };
  await finishInboxNotice({
    poll,
    notice: true,
    outputMode: "log",
    quiet: false,
    succeeded: true,
    show: () => {
      rec.shows++;
      return Promise.resolve(notice);
    },
    write: (line) => rec.lines.push(stripAnsiCode(line)),
    ...overrides,
  });
  return rec;
}

Deno.test("finishInboxNotice: a successful log-mode run settles the poll and prints the notice", async () => {
  const rec = await finish({});
  assertEquals(rec.settles, 1);
  assertEquals(rec.lines, [
    "",
    "ℹ A new message from Swamp Club is waiting for you.",
    "  To read it:  swamp inbox read",
  ]);
});

Deno.test("finishInboxNotice: --json, -q and an ineligible run settle the poll but print nothing", async () => {
  for (
    const overrides of [
      { outputMode: "json" as const },
      { quiet: true },
      { notice: false },
    ]
  ) {
    const rec = await finish(overrides);
    assertEquals(rec.settles, 1);
    assertEquals(rec.shows, 0);
    assertEquals(rec.lines, []);
  }
});

Deno.test("finishInboxNotice: the error path saves the poll but never reads or prints a notice", async () => {
  const rec = await finish({ succeeded: false });
  assertEquals(rec.settles, 1);
  assertEquals(rec.shows, 0);
  assertEquals(rec.lines, []);
});

Deno.test("finishInboxNotice: no notice waiting prints nothing", async () => {
  const rec = await finish({}, null);
  assertEquals(rec.shows, 1);
  assertEquals(rec.lines, []);
});

Deno.test("finishInboxNotice: without a poll it still shows the cached notice", async () => {
  const rec = await finish({ poll: null });
  assertEquals(rec.lines.length, 3);
});

Deno.test("finishInboxNotice: a failing poll or notice read never escapes", async () => {
  await finishInboxNotice({
    poll: { settle: () => Promise.reject(new Error("boom")) },
    notice: true,
    outputMode: "log",
    quiet: false,
    succeeded: true,
    show: () => Promise.reject(new Error("boom")),
    write: () => {},
  });
});

/** An env store a marker can read and write, seeded with `initial`. */
function envStore(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    get: (name: string) => values.get(name),
    set: (name: string, value: string) => void values.set(name, value),
    delete: (name: string) => void values.delete(name),
  };
}

Deno.test("nested runs: a swamp under another swamp is nested, but an agent swamp start launches is not", () => {
  // What a swamp that a running swamp (pid 4242) started inherits.
  const inherited = {
    [SWAMP_LOCK_HOLDER_PID]: "4242",
    [SWAMP_LOCK_ANCESTOR_PIDS]: "4242",
  };

  const nested = new LockHolderMarker(envStore(inherited), 5000);
  nested.publish();
  assertEquals(nested.ancestorPids().size > 0, true);

  // swamp start's launcher scripts unset NESTED_SWAMP_ENV_VARS before they
  // start the agent (terminal_launcher.ts), so the agent's swamp runs are
  // outermost and show the notice. Both lock variables must stay in that
  // list, or the agent would never see it.
  const launched = envStore(inherited);
  for (const name of NESTED_SWAMP_ENV_VARS) launched.delete(name);
  const agent = new LockHolderMarker(launched, 5000);
  agent.publish();
  assertEquals(agent.ancestorPids().size, 0);
});

Deno.test("commandSucceeded: only a zero exit code is a success", () => {
  assertEquals(commandSucceeded(0), true);
  assertEquals(commandSucceeded(1), false);
  assertEquals(commandSucceeded(3), false);
});
