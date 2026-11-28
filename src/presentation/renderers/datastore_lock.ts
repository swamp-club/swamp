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
  ServeLeaseStatusData,
} from "../../libswamp/datastores/lock.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, dim, green, red } from "@std/fmt/colors";
import { escapeControlCharacters } from "../../domain/control_characters.ts";

function renderLockStatusLog(data: DatastoreLockStatusData): void {
  const scope = data.lockScope ? escapeControlCharacters(data.lockScope) : "";
  const scopeLabel = scope ? ` [${scope}]` : "";

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
    `  Holder:   ${escapeControlCharacters(info.holder)}`,
    // A lock caught mid-write names no process or host to print.
    ...(info.holderUnknown ? [] : [
      `  PID:      ${escapeControlCharacters(String(info.pid))}`,
      `  Hostname: ${escapeControlCharacters(info.hostname)}`,
    ]),
    `  Acquired: ${escapeControlCharacters(info.acquiredAt)} ${
      dim(`(${ageSec}s ago)`)
    }`,
    `  TTL:      ${escapeControlCharacters(String(info.ttlMs))}ms`,
    `  Backend:  ${data.datastoreType}`,
  ];
  if (info.fence !== undefined) {
    lines.push(`  Fence:    ${escapeControlCharacters(String(info.fence))}`);
  }
  if (data.lockScope) {
    lines.push(`  Scope:    ${scope}`);
  }

  writeOutput(lines.join("\n"));
}

function renderServeLeaseLog(data: ServeLeaseStatusData): void {
  const principal = data.holder === undefined
    ? ""
    : escapeControlCharacters(data.holder.principal);
  const who = data.holder === undefined
    ? (data.heldBy === "caller" ? "another command of yours" : "another caller")
    : data.heldBy === "caller"
    ? `${principal} (you, in another command)`
    : principal;
  const holder = data.holder?.explicit === true
    ? `${who}, under an explicit lease`
    : who;
  writeOutput(
    [
      `${bold("Serve Lease:")} ${red("held")} [${
        escapeControlCharacters(data.lockKey)
      }]`,
      `  Holder:   ${holder}`,
      `  Expires:  ${escapeControlCharacters(data.expiresAt)} ${
        dim("(unless renewed)")
      }`,
    ].join("\n"),
  );
}

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
      serve_lease: (e) => {
        renderServeLeaseLog(e.data);
      },
      serve_leases_truncated: (e) => {
        writeOutput(
          dim(`Serve holds more leases than the ${e.data.listed} listed.`),
        );
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
    // serve's leases ride on the final document so a serve-mode checkout's
    // status stays one JSON document
    const serveLeases: ServeLeaseStatusData[] = [];
    let serveLeasesTruncated = false;
    return {
      completed: (e) => {
        console.log(JSON.stringify(
          {
            ...e.data,
            ...(serveLeases.length > 0 ? { serveLeases } : {}),
            ...(serveLeasesTruncated ? { serveLeasesTruncated: true } : {}),
          },
          null,
          2,
        ));
      },
      model_lock: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      serve_lease: (e) => {
        serveLeases.push(e.data);
      },
      serve_leases_truncated: () => {
        serveLeasesTruncated = true;
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

class LogDatastoreLockReleaseRenderer
  implements Renderer<DatastoreLockReleaseEvent> {
  handlers(): EventHandlers<DatastoreLockReleaseEvent> {
    return {
      completed: (e) => {
        const data = e.data;
        if (!data.released) {
          writeOutput(
            `${bold("Lock Release:")} ${
              dim(
                escapeControlCharacters(data.reason ?? "nothing to release"),
              )
            }`,
          );
          return;
        }

        const lines = [bold("Lock Released")];
        if (data.leaseHolder !== undefined) {
          lines.push(
            `  Lease held by: ${escapeControlCharacters(data.leaseHolder)}`,
          );
        }
        if (data.previousHolder) {
          lines.push(
            `  Previous holder: ${
              escapeControlCharacters(data.previousHolder.holder)
            } (pid ${
              escapeControlCharacters(String(data.previousHolder.pid))
            })`,
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
