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

import { dim } from "@std/fmt/colors";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { ModelOutputDataEvent } from "../../libswamp/models/output_data.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { carryModelWording } from "../../domain/behavior_wording.ts";
import { escapeControlCharactersInText } from "../../domain/control_characters.ts";
import {
  prettyJsonChunks,
  type Sink,
  withNewline,
  writeJsonValue,
  writeTextChunks,
} from "../output/json_stream.ts";

export interface ModelOutputDataRenderOptions {
  /** receives the JSON document, or in log mode only a JSON value; stdout when unset */
  sink?: Sink;
  isTerminal?: () => boolean;
}

function* mapChunks(
  chunks: Iterable<string>,
  map: (text: string) => string,
): Generator<string> {
  for (const chunk of chunks) yield map(chunk);
}

class LogModelOutputDataRenderer implements Renderer<ModelOutputDataEvent> {
  constructor(private readonly options: ModelOutputDataRenderOptions = {}) {}

  handlers(): EventHandlers<ModelOutputDataEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        // piped bytes stay exact; only a terminal gets the escaped form
        const shown =
          (this.options.isTerminal ?? (() => Deno.stdout.isTerminal()))()
            ? escapeControlCharactersInText
            : (text: string) => text;
        if (e.data.contentEncoding === "base64") {
          console.log(
            dim("(binary data — use --json to get it base64-encoded)"),
          );
        } else if (typeof e.data.data === "string") {
          console.log(shown(e.data.data));
        } else {
          // in pieces: indented, the value can pass V8's string limit
          await writeTextChunks(
            withNewline(mapChunks(prettyJsonChunks(e.data.data), shown)),
            this.options.sink,
          );
        }
      },
      error: (e) => {
        throw carryModelWording(e.error, new UserError(e.error.message));
      },
    };
  }
}

class JsonModelOutputDataRenderer implements Renderer<ModelOutputDataEvent> {
  constructor(private readonly options: ModelOutputDataRenderOptions = {}) {}

  handlers(): EventHandlers<ModelOutputDataEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        await writeJsonValue(e.data, this.options.sink);
      },
      error: (e) => {
        throw carryModelWording(e.error, new UserError(e.error.message));
      },
    };
  }
}

export function createModelOutputDataRenderer(
  mode: OutputMode,
  options: ModelOutputDataRenderOptions = {},
): Renderer<ModelOutputDataEvent> {
  switch (mode) {
    case "json":
      return new JsonModelOutputDataRenderer(options);
    case "log":
      return new LogModelOutputDataRenderer(options);
  }
}
