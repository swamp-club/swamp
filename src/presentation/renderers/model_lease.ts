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

import { bold, cyan, dim, green, yellow } from "@std/fmt/colors";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type {
  ModelLeaseAcquireEvent,
  ModelLeaseReleaseEvent,
  ModelLeaseStatusEvent,
  ModelLeaseView,
} from "../../libswamp/models/lease.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { OutputMode } from "../output/output.ts";
import type { Renderer } from "../renderer.ts";

function holdOf(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
}

function leaseLines(lease: ModelLeaseView, indent: string): string[] {
  return [
    `${indent}${bold(cyan("Lock:"))}    ${lease.lockKey}`,
    `${indent}${bold(cyan("Fence:"))}   ${lease.fence}`,
    `${indent}${bold(cyan("Hold:"))}    ${holdOf(lease.holdMs)} ${
      dim("(renewed by each command in this checkout)")
    }`,
    `${indent}${bold(cyan("Expires:"))} ${lease.expiresAt}`,
  ];
}

class LogAcquireRenderer implements Renderer<ModelLeaseAcquireEvent> {
  handlers(): EventHandlers<ModelLeaseAcquireEvent> {
    return {
      completed: (e) => {
        const data = e.data;
        writeOutput(
          [
            `${bold(cyan(data.existing ? "Lease renewed:" : "Lease held:"))} ${
              bold(data.behavior.name)
            } ${dim(`(${data.behavior.type})`)}`,
            ...leaseLines(data, "  "),
          ].join("\n"),
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class LogReleaseRenderer implements Renderer<ModelLeaseReleaseEvent> {
  handlers(): EventHandlers<ModelLeaseReleaseEvent> {
    return {
      completed: (e) => {
        const data = e.data;
        writeOutput(
          data.released
            ? `${bold(cyan("Lease released:"))} ${bold(data.behavior.name)}`
            : `${bold(cyan("Lease:"))} ${
              dim(`this checkout holds none on ${data.behavior.name}`)
            }`,
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class LogStatusRenderer implements Renderer<ModelLeaseStatusEvent> {
  handlers(): EventHandlers<ModelLeaseStatusEvent> {
    return {
      completed: (e) => {
        const { leases } = e.data;
        if (leases.length === 0) {
          writeOutput(
            `${bold(cyan("Leases:"))} ${dim("this checkout holds none")}`,
          );
          return;
        }
        const lines: string[] = [];
        for (const lease of leases) {
          if (lines.length > 0) lines.push("");
          lines.push(
            `${bold(cyan("Lease:"))} ${
              lease.state === "held" ? green("held") : yellow("expired")
            }`,
          );
          for (const line of leaseLines(lease, "  ")) lines.push(line);
        }
        writeOutput(lines.join("\n"));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

function jsonHandlers<T>(): {
  completed: (e: { data: T }) => void;
  error: (e: { error: { message: string } }) => never;
} {
  return {
    completed: (e) => {
      console.log(JSON.stringify(e.data, null, 2));
    },
    error: (e) => {
      throw new UserError(e.error.message);
    },
  };
}

class JsonAcquireRenderer implements Renderer<ModelLeaseAcquireEvent> {
  handlers(): EventHandlers<ModelLeaseAcquireEvent> {
    return jsonHandlers();
  }
}

class JsonReleaseRenderer implements Renderer<ModelLeaseReleaseEvent> {
  handlers(): EventHandlers<ModelLeaseReleaseEvent> {
    return jsonHandlers();
  }
}

class JsonStatusRenderer implements Renderer<ModelLeaseStatusEvent> {
  handlers(): EventHandlers<ModelLeaseStatusEvent> {
    return jsonHandlers();
  }
}

export function createModelLeaseAcquireRenderer(
  mode: OutputMode,
): Renderer<ModelLeaseAcquireEvent> {
  return mode === "json" ? new JsonAcquireRenderer() : new LogAcquireRenderer();
}

export function createModelLeaseReleaseRenderer(
  mode: OutputMode,
): Renderer<ModelLeaseReleaseEvent> {
  return mode === "json" ? new JsonReleaseRenderer() : new LogReleaseRenderer();
}

export function createModelLeaseStatusRenderer(
  mode: OutputMode,
): Renderer<ModelLeaseStatusEvent> {
  return mode === "json" ? new JsonStatusRenderer() : new LogStatusRenderer();
}
