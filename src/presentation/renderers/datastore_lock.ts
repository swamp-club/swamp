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
  DatastoreLockReleaseEvent,
  DatastoreLockStatusData,
  DatastoreLockStatusEvent,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, dim, green, red } from "@std/fmt/colors";

function renderLockStatusLog(data: DatastoreLockStatusData): void {
  const scopeLabel = data.lockScope ? ` [${data.lockScope}]` : "";

  if (!data.held || !data.info) {
    writeOutput(
      `${bold("Lock Status:")} ${green("no lock held")}${scopeLabel}`,
    );
    return;
  }

  const info = data.info;
  const ageMs = Date.now() - new Date(info.acquiredAt).getTime();
  const ageSec = Math.round(ageMs / 1000);

  const lines = [
    `${bold("Lock Status:")} ${red("locked")}${scopeLabel}`,
    `  Holder:   ${info.holder}`,
    `  PID:      ${info.pid}`,
    `  Hostname: ${info.hostname}`,
    `  Acquired: ${info.acquiredAt} ${dim(`(${ageSec}s ago)`)}`,
    `  TTL:      ${info.ttlMs}ms`,
    `  Backend:  ${data.datastoreType}`,
  ];
  if (data.lockScope) {
    lines.push(`  Scope:    ${data.lockScope}`);
  }

  writeOutput(lines.join("\n"));
}

// ── Lock status renderer ───────────────────────────────────────────────

class LogDatastoreLockStatusRenderer
  implements Renderer<DatastoreLockStatusEvent> {
  handlers(): EventHandlers<DatastoreLockStatusEvent> {
    return {
      completed: (e) => {
        renderLockStatusLog(e.data);
      },
      model_lock: (e) => {
        renderLockStatusLog(e.data);
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDatastoreLockStatusRenderer
  implements Renderer<DatastoreLockStatusEvent> {
  handlers(): EventHandlers<DatastoreLockStatusEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      model_lock: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDatastoreLockStatusRenderer(
  mode: OutputMode,
): Renderer<DatastoreLockStatusEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreLockStatusRenderer();
    case "log":
      return new LogDatastoreLockStatusRenderer();
  }
}

// ── Lock release renderer ──────────────────────────────────────────────

class LogDatastoreLockReleaseRenderer
  implements Renderer<DatastoreLockReleaseEvent> {
  handlers(): EventHandlers<DatastoreLockReleaseEvent> {
    return {
      completed: (e) => {
        const data = e.data;
        if (!data.released) {
          writeOutput(
            `${bold("Lock Release:")} ${
              dim(data.reason ?? "nothing to release")
            }`,
          );
          return;
        }

        const lines = [bold("Lock Released")];
        if (data.previousHolder) {
          lines.push(
            `  Previous holder: ${data.previousHolder.holder} (pid ${data.previousHolder.pid})`,
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

class JsonDatastoreLockReleaseRenderer
  implements Renderer<DatastoreLockReleaseEvent> {
  handlers(): EventHandlers<DatastoreLockReleaseEvent> {
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

export function createDatastoreLockReleaseRenderer(
  mode: OutputMode,
): Renderer<DatastoreLockReleaseEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreLockReleaseRenderer();
    case "log":
      return new LogDatastoreLockReleaseRenderer();
  }
}
