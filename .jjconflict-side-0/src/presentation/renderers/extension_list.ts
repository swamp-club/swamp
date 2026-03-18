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

import type { EventHandlers, ExtensionListEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

const logger = getSwampLogger(["extension", "list"]);

class LogExtensionListRenderer implements Renderer<ExtensionListEvent> {
  private verbose: boolean;

  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  handlers(): EventHandlers<ExtensionListEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        if (e.data.extensions.length === 0) {
          logger.info("No upstream extensions installed.");
          logger.info(
            "Use 'swamp extension pull @namespace/name' to install one.",
          );
          return;
        }

        const maxName = Math.max(
          ...e.data.extensions.map((ext) => ext.name.length),
        );
        const maxVersion = Math.max(
          ...e.data.extensions.map((ext) => ext.version.length + 1),
        ); // +1 for "v" prefix

        for (const ext of e.data.extensions) {
          const paddedName = ext.name.padEnd(maxName);
          const paddedVersion = `v${ext.version}`.padEnd(maxVersion);
          logger.info(
            "{line}",
            {
              line: `${paddedName}  ${paddedVersion}  (pulled ${ext.pulledAt})`,
            },
          );
          if (this.verbose) {
            for (const file of ext.files) {
              logger.info("  {file}", { file });
            }
          }
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionListRenderer implements Renderer<ExtensionListEvent> {
  handlers(): EventHandlers<ExtensionListEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionListRenderer(
  mode: OutputMode,
  verbose = false,
): Renderer<ExtensionListEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionListRenderer();
    case "log":
      return new LogExtensionListRenderer(verbose);
  }
}
