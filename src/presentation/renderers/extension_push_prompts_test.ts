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
  bumpVersionPrompt,
  existingVersionChoicePrompt,
  finalPushPrompt,
} from "./extension_push_prompts.ts";

Deno.test("finalPushPrompt: names the channel and what each answer does", () => {
  assertEquals(
    finalPushPrompt({
      name: "@x/y",
      version: "2026.10.06.1",
      channel: "stable",
    }),
    {
      details: [
        "  y = publish @x/y@2026.10.06.1 to stable now",
        "  N = exit; nothing is pushed",
      ],
      question: "Push @x/y@2026.10.06.1 to registry (channel: stable)?",
    },
  );
});

Deno.test("bumpVersionPrompt: names where the version is and that N exits without pushing", () => {
  assertEquals(
    bumpVersionPrompt({
      name: "@x/y",
      version: "2026.10.06.1",
      bumpedVersion: "2026.10.06.2",
      existingChannel: "beta",
      requestedChannel: "beta",
    }),
    {
      details: [
        "Version 2026.10.06.1 of @x/y already exists on channel 'beta'.",
        "  y = publish your local files as 2026.10.06.2 to 'beta'; " +
        "a review report for 2026.10.06.1 does not carry over to 2026.10.06.2",
        "  N = exit now; nothing is pushed",
      ],
      question: "Bump to 2026.10.06.2 and publish it to 'beta'?",
    },
  );
});

Deno.test("bumpVersionPrompt: on a higher channel, says why promote is not offered", () => {
  const prompt = bumpVersionPrompt({
    name: "@x/y",
    version: "2026.10.06.1",
    bumpedVersion: "2026.10.06.2",
    existingChannel: "stable",
    requestedChannel: "beta",
  });
  assertEquals(
    prompt.details[0],
    "Version 2026.10.06.1 of @x/y already exists on channel 'stable'; " +
      "you asked for 'beta', and a version cannot move down a channel.",
  );
  assertEquals(
    prompt.question,
    "Bump to 2026.10.06.2 and publish it to 'beta'?",
  );
});

Deno.test("existingVersionChoicePrompt: offers promote, bump and stop, in that order", () => {
  const prompt = existingVersionChoicePrompt({
    name: "@x/y",
    version: "2026.10.06.1",
    bumpedVersion: "2026.10.06.2",
    existingChannel: "beta",
    requestedChannel: "stable",
  });
  assertEquals(prompt.details, [
    "Version 2026.10.06.1 of @x/y already exists on channel 'beta'; you asked for 'stable'.",
  ]);
  assertEquals(prompt.choices, [
    {
      action: "promote",
      label:
        "Promote: move the published 'beta' build of @x/y@2026.10.06.1 to 'stable' (your local files are not uploaded)",
    },
    {
      action: "bump",
      label: "Bump: publish your local files as 2026.10.06.2 to 'stable'",
    },
    { action: "stop", label: "Stop: exit; nothing is pushed" },
  ]);
});
