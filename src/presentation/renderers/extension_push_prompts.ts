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

import { placeExistingVersion } from "../../domain/extensions/extension_publish_checks.ts";

/**
 * The wording of the interactive `swamp extension push` prompts. Each prompt
 * says what every answer does, so nobody finds out by being dropped back at
 * the shell. Kept as pure functions so the exact text is unit-tested.
 */

/** A yes/no prompt: lines printed above it, then the question. */
export interface ConfirmationPromptText {
  details: string[];
  question: string;
}

/** What the person can do when the version is on a lower channel. */
export type ExistingVersionAction = "promote" | "bump" | "stop";

/** A numbered choice: lines printed above it, then one entry per action. */
export interface ChoicePromptText {
  details: string[];
  choices: Array<{ action: ExistingVersionAction; label: string }>;
}

/** The last prompt before the push publishes. */
export function finalPushPrompt(input: {
  name: string;
  version: string;
  channel: string;
}): ConfirmationPromptText {
  const ref = `${input.name}@${input.version}`;
  return {
    details: [
      `  y = publish ${ref} to ${input.channel} now`,
      "  N = exit; nothing is pushed",
    ],
    question: `Push ${ref} to registry (channel: ${input.channel})?`,
  };
}

/**
 * The bump prompt, for a version already on the requested channel or on a
 * higher one, where promoting is not possible, and for a yanked version on
 * any channel, which stays taken and cannot be promoted.
 */
export function bumpVersionPrompt(input: {
  name: string;
  version: string;
  bumpedVersion: string;
  existingChannel: string;
  requestedChannel: string;
  /** Set when the existing version is yanked. */
  yank?: { reason?: string };
}): ConfirmationPromptText {
  const where = input.yank
    ? ` and has been yanked${
      input.yank.reason ? ` (${input.yank.reason})` : ""
    }; a yanked version stays taken and cannot be promoted.`
    : placeExistingVersion(input.existingChannel, input.requestedChannel) ===
        "higher-channel"
    ? `; you asked for '${input.requestedChannel}', and a version cannot move down a channel.`
    : ".";
  return {
    details: [
      `Version ${input.version} of ${input.name} already exists on channel '${input.existingChannel}'${where}`,
      `  y = publish your local files as ${input.bumpedVersion} to '${input.requestedChannel}'; ` +
      `a review report for ${input.version} does not carry over to ${input.bumpedVersion}`,
      "  N = exit; nothing is pushed",
    ],
    question:
      `Bump to ${input.bumpedVersion} and publish it to '${input.requestedChannel}'?`,
  };
}

/**
 * The promote, bump or stop choice, for a version already on a lower channel
 * than the one requested. It has no default: promoting moves the published
 * build, not the local files, so it is never chosen by pressing Enter.
 */
export function existingVersionChoicePrompt(input: {
  name: string;
  version: string;
  bumpedVersion: string;
  existingChannel: string;
  requestedChannel: string;
}): ChoicePromptText {
  const { name, version, bumpedVersion, existingChannel, requestedChannel } =
    input;
  return {
    details: [
      `Version ${version} of ${name} already exists on channel '${existingChannel}'; you asked for '${requestedChannel}'.`,
    ],
    choices: [
      {
        action: "promote",
        label:
          `Promote: move the published '${existingChannel}' build of ${name}@${version} to '${requestedChannel}' (your local files are not uploaded)`,
      },
      {
        action: "bump",
        label:
          `Bump: publish your local files as ${bumpedVersion} to '${requestedChannel}'`,
      },
      { action: "stop", label: "Stop: exit; nothing is pushed" },
    ],
  };
}
