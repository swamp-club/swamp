// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["extension", "list"]);

/** A single extension entry for list output. */
export interface ExtensionListEntry {
  name: string;
  version: string;
  pulledAt: string;
  files: string[];
}

/** Data for extension list output. */
export interface ExtensionListData {
  extensions: ExtensionListEntry[];
}

/**
 * Renders the extension list output.
 */
export function renderExtensionList(
  data: ExtensionListData,
  mode: OutputMode,
  verbose: boolean,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.extensions.length === 0) {
    logger.info("No upstream extensions installed.");
    logger.info(
      "Use 'swamp extension pull @namespace/name' to install one.",
    );
    return;
  }

  const maxName = Math.max(...data.extensions.map((e) => e.name.length));
  const maxVersion = Math.max(
    ...data.extensions.map((e) => e.version.length + 1),
  ); // +1 for "v" prefix

  for (const ext of data.extensions) {
    const paddedName = ext.name.padEnd(maxName);
    const paddedVersion = `v${ext.version}`.padEnd(maxVersion);
    logger.info(
      "{line}",
      { line: `${paddedName}  ${paddedVersion}  (pulled ${ext.pulledAt})` },
    );
    if (verbose) {
      for (const file of ext.files) {
        logger.info("  {file}", { file });
      }
    }
  }
}
