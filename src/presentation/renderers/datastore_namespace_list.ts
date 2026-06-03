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

import { bold, green } from "@std/fmt/colors";
import type { EventHandlers, NamespaceListEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { Table } from "@cliffy/table";

class LogNamespaceListRenderer implements Renderer<NamespaceListEvent> {
  handlers(): EventHandlers<NamespaceListEvent> {
    return {
      completed: (e) => {
        const { namespaces } = e.data;

        if (namespaces.length === 0) {
          writeOutput("No namespaces registered in this datastore.");
          return;
        }

        const table = new Table()
          .header(
            [
              "namespace",
              "repoId",
              "registeredAt",
              "current",
            ].map((h) => bold(h)),
          )
          .body(
            namespaces.map((ns) => [
              ns.namespace,
              ns.repoId || "-",
              ns.registeredAt ? ns.registeredAt.slice(0, 10) : "-",
              ns.isCurrent ? green("*") : "",
            ]),
          )
          .border(true)
          .padding(1);

        writeOutput(table.toString());
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonNamespaceListRenderer implements Renderer<NamespaceListEvent> {
  handlers(): EventHandlers<NamespaceListEvent> {
    return {
      completed: (e) => {
        writeOutput(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createNamespaceListRenderer(
  mode: OutputMode,
): Renderer<NamespaceListEvent> {
  switch (mode) {
    case "json":
      return new JsonNamespaceListRenderer();
    case "log":
      return new LogNamespaceListRenderer();
  }
}
