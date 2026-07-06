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

import { z } from "zod";
import { defineModel, type MethodContext } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";

export const IT_TYPE = ModelType.create("swamp/remote-it");
export const IT_DEFINITION_ID = "7d4f2a1e-1111-4222-8333-444455556666";

defineModel({
  type: IT_TYPE,
  version: "2026.06.09.1",
  resources: {
    "result": {
      description: "integration result",
      schema: z.object({
        echo: z.string(),
        sawEnv: z.string().optional(),
        priorWasNull: z.boolean().optional(),
        vaultRoundTrip: z.string().optional(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  files: {
    "log": {
      description: "integration log",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      streaming: true,
    },
  },
  methods: {
    run: {
      description: "exercise the capability verbs",
      kind: "action",
      arguments: z.object({
        echo: z.string(),
        mode: z.enum(["normal", "hang"]).default("normal"),
      }),
      execute: async (args, context: MethodContext) => {
        const input = args as { echo: string; mode: "normal" | "hang" };
        if (input.mode === "hang") {
          await new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () =>
                reject(
                  new DOMException("hung step aborted", "AbortError"),
                ),
            );
          });
        }

        const writer = context.createFileWriter!("log", "log-main");
        await writer.writeLine("line one");
        await writer.writeLine("line two");
        const logHandle = await writer.finalize();

        const prior = await context.readResource!("result-main");

        await context.vaultService!.put("local", "from-method", "round-trip");
        const vaultRoundTrip = await context.vaultService!.get(
          "local",
          "from-method",
        );

        const resultHandle = await context.writeResource!(
          "result",
          "result-main",
          {
            echo: input.echo,
            sawEnv: Deno.env.get("REMOTE_IT_ENV"),
            priorWasNull: prior === null,
            vaultRoundTrip,
          },
        );
        return { dataHandles: [resultHandle, logHandle] };
      },
    },
  },
});
