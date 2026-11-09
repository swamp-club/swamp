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

import { UserError } from "../errors.ts";
import { CalVer } from "../models/calver.ts";
import { ReleaseChannel } from "./release_channel.ts";

// Mirrors VERSION_CONSTRAINT_PREFIX in src/libswamp/extensions/pull.ts.
const VERSION_CONSTRAINT_PREFIX = /^[><=^~!]/;

export interface ExtensionVersionArgument {
  name: string;
  version: string | null;
}

/**
 * any version spelling swamp prints is accepted back: name@version, a v prefix,
 * a channel tag or label, a pulled-at note. The name is not validated here.
 */
export function parseExtensionVersionArgument(
  extensionArgument: string,
  versionArgument?: string,
): ExtensionVersionArgument {
  if (!extensionArgument.startsWith("@")) {
    throw new UserError(
      `Invalid extension name: "${extensionArgument}". Extension names must start with "@" (e.g., @collective/name).`,
    );
  }
  const separator = extensionArgument.indexOf("@", 1);
  const name = separator === -1
    ? extensionArgument
    : extensionArgument.slice(0, separator);
  const inline = separator === -1
    ? undefined
    : extensionArgument.slice(separator + 1);
  if (inline !== undefined && inline.trim() === "") {
    throw new UserError(
      `Invalid extension reference: "${extensionArgument}". Version cannot be empty after "@".`,
    );
  }

  const inlineVersion = inline === undefined
    ? undefined
    : normalizeVersion(inline);
  const positionalVersion = versionArgument === undefined
    ? undefined
    : normalizeVersion(versionArgument);

  if (
    inlineVersion !== undefined && positionalVersion !== undefined &&
    inlineVersion !== positionalVersion
  ) {
    throw new UserError(
      `Two different versions given: "${inline}" in "${extensionArgument}" and "${versionArgument}" as the version argument. Pass one.`,
    );
  }
  return { name, version: inlineVersion ?? positionalVersion ?? null };
}

function normalizeVersion(raw: string): string {
  const trimmed = raw.trim();
  if (VERSION_CONSTRAINT_PREFIX.test(trimmed)) return trimmed;
  return CalVer.fromUserInput(stripDisplayDecorations(trimmed)).value;
}

// String scans rather than regexes: serve runs this on client-supplied input.
function stripDisplayDecorations(raw: string): string {
  let text = raw.trim();
  if (text.endsWith(")")) {
    const open = text.lastIndexOf("(pulled ");
    if (open !== -1) text = text.slice(0, open).trim();
  }
  if (text.endsWith("]")) {
    const open = text.lastIndexOf("[");
    if (open !== -1) text = text.slice(0, open).trim();
  }
  const colon = text.indexOf(":");
  if (colon !== -1 && ReleaseChannel.isValid(text.slice(0, colon).trim())) {
    text = text.slice(colon + 1).trim();
  }
  return text;
}
