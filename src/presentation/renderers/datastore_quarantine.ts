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
import type {
  DatastoreQuarantineAcceptData,
  DatastoreQuarantineAcceptEvent,
} from "../../libswamp/datastores/quarantine_accept.ts";
import type {
  DatastoreQuarantineDiscardData,
  DatastoreQuarantineDiscardEvent,
} from "../../libswamp/datastores/quarantine_discard.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

function renderAcceptLog(data: DatastoreQuarantineAcceptData): void {
  const lines = [
    `${bold(cyan("Accepted:"))} ${bold(data.txnId)}${
      data.duplicate ? ` ${dim("(already accepted)")}` : ""
    }`,
    `  Partition: ${data.partition}`,
    `  Author:    ${data.author} ${dim("(it landed as them)")}`,
    `  Accepted:  ${data.acceptedBy} at ${data.acceptedAt}`,
  ];
  if (data.seq !== undefined) lines.push(`  Seq:       ${data.seq}`);
  if (data.renumbered.length > 0) {
    lines.push("");
    lines.push(cyan("Renumbered after what landed meanwhile:"));
    for (const version of data.renumbered) {
      lines.push(`  ${version.name} ${version.from} ${dim("→")} ${version.to}`);
    }
  }
  lines.push("");
  lines.push(
    `${bold(cyan("Result:"))} ${green("landed")} ${
      dim("- the author's next command settles it")
    }`,
  );
  writeOutput(lines.join("\n"));
}

class LogDatastoreQuarantineAcceptRenderer
  implements Renderer<DatastoreQuarantineAcceptEvent> {
  handlers(): EventHandlers<DatastoreQuarantineAcceptEvent> {
    return {
      accepting: () => {},
      completed: (e) => renderAcceptLog(e.data),
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    };
  }
}

class JsonDatastoreQuarantineAcceptRenderer
  implements Renderer<DatastoreQuarantineAcceptEvent> {
  handlers(): EventHandlers<DatastoreQuarantineAcceptEvent> {
    return {
      accepting: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    };
  }
}

export function createDatastoreQuarantineAcceptRenderer(
  mode: OutputMode,
): Renderer<DatastoreQuarantineAcceptEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreQuarantineAcceptRenderer();
    case "log":
      return new LogDatastoreQuarantineAcceptRenderer();
  }
}

function renderDiscardLog(data: DatastoreQuarantineDiscardData): void {
  writeOutput([
    `${bold(cyan("Discarded:"))} ${bold(data.txnId)}${
      data.duplicate ? ` ${dim("(already discarded)")}` : ""
    }`,
    `  Partition: ${data.partition}`,
    `  Author:    ${data.author}`,
    `  Discarded: ${data.discardedBy} at ${data.discardedAt}`,
    "",
    `${bold(cyan("Result:"))} ${yellow("discarded")} ${
      dim("- it never lands; the author's next command keeps it as rejected")
    }`,
  ].join("\n"));
}

class LogDatastoreQuarantineDiscardRenderer
  implements Renderer<DatastoreQuarantineDiscardEvent> {
  handlers(): EventHandlers<DatastoreQuarantineDiscardEvent> {
    return {
      discarding: () => {},
      completed: (e) => renderDiscardLog(e.data),
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    };
  }
}

class JsonDatastoreQuarantineDiscardRenderer
  implements Renderer<DatastoreQuarantineDiscardEvent> {
  handlers(): EventHandlers<DatastoreQuarantineDiscardEvent> {
    return {
      discarding: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    };
  }
}

export function createDatastoreQuarantineDiscardRenderer(
  mode: OutputMode,
): Renderer<DatastoreQuarantineDiscardEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreQuarantineDiscardRenderer();
    case "log":
      return new LogDatastoreQuarantineDiscardRenderer();
  }
}
