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
  EventHandlers,
  ExtensionListEntry,
  ExtensionListEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { getTerminalColumns } from "../output/terminal_size.ts";

const logger = getSwampLogger(["extension", "list"]);

/**
 * Presentation-layer extension entry that may carry freshness data.
 *
 * Extends the libswamp ExtensionListEntry with optional fields populated
 * by the CLI-layer freshness composer. When `updateStatus` is undefined,
 * enrichment was skipped (TTY-off default or --no-check-updates) and
 * the renderer falls back to the bare list display. When
 * `updateStatus === "unknown_offline"` enrichment was attempted but the
 * registry call failed; `latestVersion` is null in that case.
 */
export interface EnrichedExtensionListEntry extends ExtensionListEntry {
  latestVersion?: string | null;
  updateStatus?:
    | "up_to_date"
    | "update_available"
    | "unknown_offline"
    | "deprecated";
}

class LogExtensionListRenderer implements Renderer<EnrichedExtensionListEvent> {
  private verbose: boolean;

  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  handlers(): EventHandlers<EnrichedExtensionListEvent> {
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

        const exts = e.data.extensions;
        const enriched = exts.some((x) => x.updateStatus !== undefined);
        const cols = getTerminalColumns();

        const maxName = Math.min(
          Math.max(...exts.map((ext) => ext.name.length)),
          Math.floor(cols * 0.4),
        );
        const maxVersion = Math.max(
          ...exts.map((ext) => {
            const tag = ext.channel && ext.channel !== "stable"
              ? ` [${ext.channel}]`
              : "";
            return ext.version.length + 1 + tag.length;
          }),
        );
        const maxLatest = enriched
          ? Math.max(
            ...exts.map((ext) =>
              ext.latestVersion ? ext.latestVersion.length + 1 : 1
            ),
          )
          : 0;

        for (const ext of exts) {
          const name = ext.name.length > maxName
            ? ext.name.substring(0, maxName - 1) + "…"
            : ext.name;
          const paddedName = name.padEnd(maxName);
          const channelTag = ext.channel && ext.channel !== "stable"
            ? ` [${ext.channel}]`
            : "";
          const paddedVersion = `v${ext.version}${channelTag}`.padEnd(
            maxVersion,
          );
          let line = `${paddedName}  ${paddedVersion}`;
          if (enriched) {
            const latestText = ext.latestVersion
              ? `v${ext.latestVersion}`
              : "—";
            line += `  ${latestText.padEnd(maxLatest)}`;
            if (ext.updateStatus === "update_available") {
              line += "  (update available)";
            } else if (ext.updateStatus === "unknown_offline") {
              line += "  (offline — last check failed)";
            } else if (ext.updateStatus === "deprecated") {
              line += "  (deprecated)";
            }
          }
          line += `  (pulled ${ext.pulledAt})`;
          logger.info("{line}", { line });
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

class JsonExtensionListRenderer
  implements Renderer<EnrichedExtensionListEvent> {
  handlers(): EventHandlers<EnrichedExtensionListEvent> {
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

/** Event type carrying enriched entries; identical shape to ExtensionListEvent
 *  with EnrichedExtensionListEntry replacing ExtensionListEntry. */
export type EnrichedExtensionListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: { extensions: EnrichedExtensionListEntry[] } }
  | (Extract<ExtensionListEvent, { kind: "error" }>);

export function createExtensionListRenderer(
  mode: OutputMode,
  verbose = false,
): Renderer<EnrichedExtensionListEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionListRenderer();
    case "log":
      return new LogExtensionListRenderer(verbose);
  }
}
