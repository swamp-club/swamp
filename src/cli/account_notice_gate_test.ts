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
import type {
  AccountNoticePoll,
  AccountNoticeView,
} from "../libswamp/account_notices/notice.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";
import { rewriteDirectTypeArgs } from "./arg_rewriter.ts";
import { authGateTiming } from "./auth_gate_exemptions.ts";
import {
  type AccountNoticeEligibility,
  accountNoticeEligibility,
  finishAccountNotice,
  type FinishAccountNoticeOptions,
} from "./account_notice_gate.ts";
import { buildCommandTree } from "./mod.ts";
import { resolveTelemetryInvocation } from "./telemetry_invocation.ts";

const tree = await buildCommandTree();

function eligibility(
  args: string[],
  overrides: { gatePassed?: boolean; nested?: boolean; hook?: boolean } = {},
): AccountNoticeEligibility {
  const rewritten = rewriteDirectTypeArgs(args);
  return accountNoticeEligibility({
    commandPath:
      resolveTelemetryInvocation(tree, [...rewritten], []).commandPath ?? [],
    gateTiming: authGateTiming(tree, rewritten),
    gatePassed: overrides.gatePassed ?? true,
    nested: overrides.nested ?? false,
    hook: overrides.hook ?? false,
  });
}

const notice: AccountNoticeView = {
  kind: "trial-ended",
  slug: "keeb",
  name: "keeb",
  personal: true,
  billingUrl: "https://swamp-club.com/billing",
};

Deno.test("accountNoticeEligibility: slow commands poll on schedule, in every spelling", () => {
  for (
    const args of [
      ["workflow", "run", "deploy"],
      ["model", "method", "run", "m", "sync"],
      ["behavior", "run", "m", "sync"],
      ["extension", "pull", "@a/b"],
      ["--json", "workflow", "run", "deploy"],
      ["extension", "push", "manifest.yaml"],
    ]
  ) {
    assertEquals(
      eligibility(args),
      { eligible: true, slowCommand: true },
      args.join(" "),
    );
  }
});

Deno.test("accountNoticeEligibility: fast commands are eligible but not slow", () => {
  assertEquals(eligibility(["data", "list"]), {
    eligible: true,
    slowCommand: false,
  });
});

Deno.test("accountNoticeEligibility: the inbox's excluded groups never show it", () => {
  for (
    const args of [
      ["inbox"],
      ["subscription", "status"],
      ["auth", "whoami"],
      ["serve"],
      // the dispatch runner returns before teardown, so it must never poll
      ["worker", "exec-dispatch"],
    ]
  ) {
    assertEquals(eligibility(args).eligible, false, args.join(" "));
  }
});

Deno.test("accountNoticeEligibility: a nested run or a blocked gate is not eligible", () => {
  assertEquals(eligibility(["data", "list"], { nested: true }).eligible, false);
  assertEquals(
    eligibility(["workflow", "run", "x"], { gatePassed: false }),
    { eligible: false, slowCommand: false },
  );
});

Deno.test("accountNoticeEligibility: no environment variable turns it off", () => {
  withMockedEnv(
    { CI: "true", SWAMP_NO_INBOX_NOTICE: "1", SWAMP_NO_UPDATE_CHECK: "1" },
    () => {
      assertEquals(eligibility(["workflow", "run", "x"]), {
        eligible: true,
        slowCommand: true,
      });
    },
  );
});

function finishOptions(
  overrides: Partial<FinishAccountNoticeOptions> = {},
): { options: FinishAccountNoticeOptions; lines: string[]; settled: number[] } {
  const lines: string[] = [];
  const settled: number[] = [];
  const poll: AccountNoticePoll = {
    settle: () => {
      settled.push(1);
      return Promise.resolve();
    },
  };
  return {
    lines,
    settled,
    options: {
      poll,
      eligible: true,
      outputMode: "log",
      quiet: false,
      succeeded: true,
      show: () => Promise.resolve(notice),
      write: (line) => lines.push(stripAnsiCode(line)),
      ...overrides,
    },
  };
}

Deno.test("finishAccountNotice: a successful log-mode run settles the poll and prints the notice", async () => {
  const { options, lines, settled } = finishOptions();
  await finishAccountNotice(options);
  assertEquals(settled.length, 1);
  assertEquals(lines, [
    "",
    "⚠ Your Swamp Club trial has ended.",
    "  Choose a plan:  https://swamp-club.com/billing",
  ]);
});

Deno.test("finishAccountNotice: --json, -q, a failed command or an ineligible run settle but print nothing", async () => {
  for (
    const overrides of [
      { outputMode: "json" as const },
      { quiet: true },
      { succeeded: false },
      { eligible: false },
    ]
  ) {
    const { options, lines, settled } = finishOptions(overrides);
    await finishAccountNotice(options);
    assertEquals(settled.length, 1, JSON.stringify(overrides));
    assertEquals(lines, [], JSON.stringify(overrides));
  }
});

Deno.test("finishAccountNotice: nothing to show prints nothing; without a poll it still shows", async () => {
  const none = finishOptions({ show: () => Promise.resolve(null) });
  await finishAccountNotice(none.options);
  assertEquals(none.lines, []);
  const noPoll = finishOptions({ poll: null });
  await finishAccountNotice(noPoll.options);
  assertEquals(noPoll.lines.length, 3);
});

Deno.test("finishAccountNotice: a failing poll or read never escapes", async () => {
  const failing = finishOptions({
    poll: { settle: () => Promise.reject(new Error("boom")) },
  });
  await finishAccountNotice(failing.options);
  const failingShow = finishOptions({
    show: () => Promise.reject(new Error("boom")),
  });
  await finishAccountNotice(failingShow.options);
});

Deno.test("accountNoticeEligibility: a hook run returns before teardown, so it never polls", () => {
  assertEquals(
    eligibility(["audit", "record", "--from-hook"], { hook: true }),
    { eligible: false, slowCommand: false },
  );
  assertEquals(
    eligibility(["workflow", "run", "x"], { hook: true }),
    { eligible: false, slowCommand: false },
  );
});
