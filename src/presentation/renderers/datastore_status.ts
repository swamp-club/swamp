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

import { bold, dim, green, red, yellow } from "@std/fmt/colors";
import type { DatastoreStatusEvent } from "../../libswamp/datastores/status.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

/** An outbox entry's state, colored. */
function stateLabel(state: "offline" | "rejected" | "quarantined"): string {
  switch (state) {
    case "offline":
      return yellow("offline");
    case "rejected":
      return red("rejected");
    case "quarantined":
      return red("quarantined");
  }
}

class LogDatastoreStatusRenderer implements Renderer<DatastoreStatusEvent> {
  handlers(): EventHandlers<DatastoreStatusEvent> {
    return {
      completed: (e) => {
        const data = e.data;
        const healthIcon = data.healthy ? green("\u25CF") : red("\u25CF");
        const healthText = data.healthy ? green("healthy") : red("unhealthy");

        const lines = [
          bold("Datastore Status"),
          `  Type:    ${data.type}`,
        ];
        if (data.path) {
          lines.push(`  Path:    ${data.path}`);
        }
        if (data.format !== undefined) {
          lines.push(`  Format:  ${data.format} (v3 commit log)`);
        }
        if (data.commitLog !== undefined) {
          lines.push(
            `  Commits: ${data.commitLog.storedCommits} stored, compacted through ${data.commitLog.compactedThrough}`,
          );
        }
        lines.push(
          `  Health:  ${healthIcon} ${healthText} (${
            Math.round(data.latencyMs)
          }ms)`,
        );
        if (!data.healthy) {
          lines.push(`  Error:   ${data.message}`);
        }
        lines.push(`  Dirs:    ${data.directories.join(", ")}`);
        if (data.exclude && data.exclude.length > 0) {
          lines.push(`  Exclude: ${data.exclude.join(", ")}`);
        }
        if (data.explicitLeases !== undefined) {
          lines.push("");
          lines.push(bold("Explicit Leases"));
          if (data.explicitLeases.length === 0) {
            lines.push(`  ${dim("none held")}`);
          }
          for (const lease of data.explicitLeases) {
            lines.push(
              `  ${lease.lockKey} ${
                dim("-")
              } ${lease.holder}, until ${lease.expiresAt}`,
            );
          }
        }
        if (data.heldLeases !== undefined) {
          lines.push("");
          lines.push(bold("Leases This Checkout Holds"));
          if (data.heldLeases.length === 0) {
            lines.push(`  ${dim("none")}`);
          }
          for (const lease of data.heldLeases) {
            lines.push(
              `  ${lease.lockKey} ${
                dim("-")
              } fence ${lease.fence}, until ${lease.expiresAt}`,
            );
          }
        }
        if (data.outbox !== undefined && data.outbox.length > 0) {
          lines.push("");
          lines.push(bold("Saved In This Checkout"));
          for (const entry of data.outbox) {
            lines.push(
              `  ${stateLabel(entry.state)} ${entry.partition} ${
                dim(`(${entry.txnId}, saved ${entry.savedAt})`)
              }`,
            );
            if (entry.reason !== undefined) {
              lines.push(`    ${dim(entry.reason)}`);
            }
          }
        }
        if (data.quarantine !== undefined) {
          lines.push("");
          lines.push(bold("Quarantined Changes"));
          if (data.quarantine.length === 0) {
            lines.push(`  ${dim("none kept")}`);
          }
          for (const change of data.quarantine) {
            const state = change.state === "held"
              ? yellow("held")
              : change.state === "discarded"
              ? red("discarded")
              : green("accepted");
            lines.push(
              `  ${state} ${change.txnId} ${
                dim("-")
              } ${change.partition} by ${change.author}`,
            );
            lines.push(
              change.state === "held"
                ? `    ${dim(change.reason)}`
                : change.state === "discarded"
                ? `    ${
                  dim(
                    `discarded by ${change.discardedBy ?? "an admin"} at ${
                      change.discardedAt ?? "?"
                    }`,
                  )
                }`
                : `    ${
                  dim(
                    `accepted by ${change.acceptedBy ?? "an admin"} at ${
                      change.acceptedAt ?? "?"
                    }`,
                  )
                }`,
            );
          }
          if (data.quarantineTruncated === true) {
            lines.push(
              `  ${dim("more accepted or discarded changes are kept")}`,
            );
          }
        }
        if (data.serveSectionAbsent !== undefined) {
          lines.push("");
          lines.push(
            dim(`Serve's leases and quarantine: ${data.serveSectionAbsent}`),
          );
        }

        writeOutput(lines.join("\n"));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDatastoreStatusRenderer implements Renderer<DatastoreStatusEvent> {
  handlers(): EventHandlers<DatastoreStatusEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDatastoreStatusRenderer(
  mode: OutputMode,
): Renderer<DatastoreStatusEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreStatusRenderer();
    case "log":
      return new LogDatastoreStatusRenderer();
  }
}
