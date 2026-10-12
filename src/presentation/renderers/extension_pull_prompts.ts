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

import type {
  ExtensionIdentity,
  ExtensionReplacement,
} from "../../domain/extensions/extension_replacement.ts";
import type { UnoptedPrereleaseNotice } from "../../libswamp/extensions/pull.ts";

/**
 * The wording of what `swamp extension pull` says before it replaces an
 * installed extension. Kept as pure functions so the exact text is
 * unit-tested; the renderer logs these lines unchanged.
 */

/** A yes/no prompt: lines printed above it, then the question. */
export interface ConfirmationPromptText {
  details: string[];
  question: string;
}

/** "2026.10.01.1 (beta, following stable)": a version and its channels. */
function describeSide(side: ExtensionIdentity): string {
  const published = side.publishedChannel ?? "channel unknown";
  const following = side.channel !== null &&
      side.channel !== side.publishedChannel
    ? `, following ${side.channel}`
    : "";
  return `${side.version} (${published}${following})`;
}

/** A version and the channel it is published on, when known. */
function shortSide(side: ExtensionIdentity): string {
  return side.publishedChannel
    ? `${side.version} (${side.publishedChannel})`
    : side.version;
}

/**
 * The two lines naming the extension, what is installed and what is
 * coming, then how they relate.
 */
export function replacementSummary(r: ExtensionReplacement): string[] {
  const installed = r.current
    ? `installed ${describeSide(r.current)}`
    : "installed unknown";
  const headline = `${r.name}: ${installed} -> incoming ${
    describeSide(r.incoming)
  }`;

  const incoming = r.incoming.version;
  const current = r.current?.version;
  let relation: string;
  switch (r.change) {
    case "upgrade":
      relation = `Upgrade: ${incoming} is newer than the installed ${current}.`;
      break;
    case "downgrade":
      relation =
        `Downgrade: ${incoming} is older than the installed ${current}.`;
      break;
    case "same":
      relation =
        `Same version: ${incoming} is already installed; its files will be rewritten.`;
      break;
    default:
      relation = "Installed version unknown: it could not be determined.";
  }
  if (r.channelChanged && r.current) {
    relation +=
      ` Channel change: ${r.current.publishedChannel} to ${r.incoming.publishedChannel}.`;
  }
  return [headline, relation];
}

/**
 * The line warning that a beta or rc release is being installed while the
 * extension follows stable, and how to follow its channel instead.
 */
export function unoptedPrereleaseWarning(
  notice: UnoptedPrereleaseNotice,
): string {
  const { name, version, publishedChannel, parent } = notice;
  const why = parent
    ? `installed because ${parent} pins it`
    : "and --channel was not passed";
  const article = publishedChannel === "rc" ? "an" : "a";
  return `${name}@${version} is ${article} ${publishedChannel} release, ${why}: ` +
    `swamp extension update keeps following stable for ${name}. ` +
    `Run swamp extension pull ${name} --channel ${publishedChannel} to follow ${publishedChannel}.`;
}

/** The overwrite prompt, saying what each answer does. */
export function overwritePrompt(
  replacement: ExtensionReplacement | undefined,
  hasSkillDirs: boolean,
): ConfirmationPromptText {
  let yes: string;
  if (!replacement) {
    yes = "  y = overwrite the files listed above";
  } else if (replacement.change === "same") {
    yes = `  y = rewrite the files of ${shortSide(replacement.incoming)}`;
  } else {
    const from = replacement.current
      ? shortSide(replacement.current)
      : "the installed files";
    yes = `  y = replace ${from} with ${shortSide(replacement.incoming)}`;
  }
  return {
    details: [yes, "  N = exit; nothing is changed"],
    question: hasSkillDirs
      ? "Write into the existing paths, overwriting same-named files?"
      : "Overwrite existing files?",
  };
}
