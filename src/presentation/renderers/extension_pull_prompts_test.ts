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
import {
  type ExtensionIdentity,
  ExtensionReplacement,
} from "../../domain/extensions/extension_replacement.ts";
import {
  overwritePrompt,
  replacementSummary,
  unoptedPrereleaseWarning,
} from "./extension_pull_prompts.ts";

const NAME = "@svendowideit/systemd-creds";

function side(
  version: string,
  publishedChannel: string | null,
  channel: string | null = "stable",
): ExtensionIdentity {
  return { version, channel, publishedChannel };
}

function replace(
  current: ExtensionIdentity | null,
  incoming: ExtensionIdentity,
): ExtensionReplacement {
  return ExtensionReplacement.create({ name: NAME, current, incoming });
}

Deno.test("replacementSummary: an upgrade", () => {
  assertEquals(
    replacementSummary(
      replace(side("2026.09.23.1", "stable"), side("2026.10.01.1", "stable")),
    ),
    [
      `${NAME}: installed 2026.09.23.1 (stable) -> incoming 2026.10.01.1 (stable)`,
      "Upgrade: 2026.10.01.1 is newer than the installed 2026.09.23.1.",
    ],
  );
});

Deno.test("replacementSummary: a downgrade", () => {
  assertEquals(
    replacementSummary(
      replace(side("2026.10.01.1", "stable"), side("2026.09.01.1", "stable")),
    )[1],
    "Downgrade: 2026.09.01.1 is older than the installed 2026.10.01.1.",
  );
});

Deno.test("replacementSummary: the same version", () => {
  assertEquals(
    replacementSummary(
      replace(side("2026.10.01.1", "stable"), side("2026.10.01.1", "stable")),
    )[1],
    "Same version: 2026.10.01.1 is already installed; its files will be rewritten.",
  );
});

Deno.test("replacementSummary: a channel change names both channels, and the followed one where it differs", () => {
  assertEquals(
    replacementSummary(
      replace(side("2026.09.23.1", "stable"), side("2026.10.01.1", "beta")),
    ),
    [
      `${NAME}: installed 2026.09.23.1 (stable) -> incoming 2026.10.01.1 (beta, following stable)`,
      "Upgrade: 2026.10.01.1 is newer than the installed 2026.09.23.1. Channel change: stable to beta.",
    ],
  );
});

Deno.test("replacementSummary: an unknown installed version says so", () => {
  assertEquals(
    replacementSummary(replace(null, side("2026.10.01.1", "beta", "beta"))),
    [
      `${NAME}: installed unknown -> incoming 2026.10.01.1 (beta)`,
      "Installed version unknown: it could not be determined.",
    ],
  );
});

Deno.test("replacementSummary: an unknown published channel says so", () => {
  assertEquals(
    replacementSummary(
      replace(side("2026.09.23.1", null, null), side("2026.10.01.1", null)),
    )[0],
    `${NAME}: installed 2026.09.23.1 (channel unknown) -> incoming 2026.10.01.1 (channel unknown, following stable)`,
  );
});

Deno.test("unoptedPrereleaseWarning: a top-level pull without --channel", () => {
  assertEquals(
    unoptedPrereleaseWarning({
      name: NAME,
      version: "2026.10.01.1",
      publishedChannel: "beta",
      parent: null,
    }),
    `${NAME}@2026.10.01.1 is a beta release, and --channel was not passed: ` +
      `swamp extension update keeps following stable for ${NAME}. ` +
      `Run swamp extension pull ${NAME} --channel beta to follow beta.`,
  );
});

Deno.test("unoptedPrereleaseWarning: a dependency names the parent that pins it", () => {
  assertEquals(
    unoptedPrereleaseWarning({
      name: "@a/dep",
      version: "2026.10.01.1",
      publishedChannel: "rc",
      parent: "@a/parent",
    }),
    "@a/dep@2026.10.01.1 is an rc release, installed because @a/parent pins it: " +
      "swamp extension update keeps following stable for @a/dep. " +
      "Run swamp extension pull @a/dep --channel rc to follow rc.",
  );
});

Deno.test("overwritePrompt: says what y and N do", () => {
  assertEquals(
    overwritePrompt(
      replace(side("2026.09.23.1", "stable"), side("2026.10.01.1", "beta")),
      false,
    ),
    {
      details: [
        "  y = replace 2026.09.23.1 (stable) with 2026.10.01.1 (beta)",
        "  N = exit; nothing is changed",
      ],
      question: "Overwrite existing files?",
    },
  );
});

Deno.test("overwritePrompt: the same version is rewritten", () => {
  assertEquals(
    overwritePrompt(
      replace(side("2026.10.01.1", "stable"), side("2026.10.01.1", "stable")),
      false,
    ).details[0],
    "  y = rewrite the files of 2026.10.01.1 (stable)",
  );
});

Deno.test("overwritePrompt: an unknown installed version, and skill dirs", () => {
  assertEquals(
    overwritePrompt(replace(null, side("2026.10.01.1", "stable")), true),
    {
      details: [
        "  y = replace the installed files with 2026.10.01.1 (stable)",
        "  N = exit; nothing is changed",
      ],
      question: "Write into the existing paths, overwriting same-named files?",
    },
  );
});

Deno.test("overwritePrompt: without a replacement, keeps today's question", () => {
  assertEquals(overwritePrompt(undefined, false), {
    details: [
      "  y = overwrite the files listed above",
      "  N = exit; nothing is changed",
    ],
    question: "Overwrite existing files?",
  });
});
