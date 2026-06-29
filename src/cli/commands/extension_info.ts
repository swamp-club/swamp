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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import {
  consumeStream,
  createExtensionInfoDeps,
  createLibSwampContext,
  extensionInfo,
  type ExtensionInfoData,
} from "../../libswamp/mod.ts";
import { createExtensionInfoRenderer } from "../../presentation/renderers/extension_info.ts";
import { loadIdentity } from "../load_identity.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ExtensionInfoResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionInfoCommand = withRemoteOptions(
  new Command()
    .name("info")
    .description(
      "Show full registry metadata for a specific extension",
    )
    .example(
      "Show extension info",
      "swamp extension info @stack72/aws-ec2",
    )
    .example(
      "JSON output",
      "swamp extension info @stack72/aws-ec2 --json",
    )
    .arguments("<name:string>"),
).action(
  async function (options: AnyOptions, name: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "info",
    ]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerToken(
        server,
        options.token as string | undefined,
      );
      const response = await requestServerResponse<ExtensionInfoResponse>(
        { server, token },
        {
          type: "extension.info",
          payload: { extensionName: name },
        },
      );
      const verbose = cliCtx.verbosity === "verbose";
      const renderer = createExtensionInfoRenderer(
        cliCtx.outputMode,
        verbose,
      );
      await consumeStream(
        (async function* () {
          yield {
            kind: "completed" as const,
            data: response.data as unknown as ExtensionInfoData,
          };
        })(),
        renderer.handlers(),
      );
      return;
    }

    const identity = await loadIdentity();
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createExtensionInfoDeps(identity.bearerToken, identity);
    const verbose = cliCtx.verbosity === "verbose";
    const renderer = createExtensionInfoRenderer(
      cliCtx.outputMode,
      verbose,
    );

    await consumeStream(
      extensionInfo(ctx, deps, { extensionName: name }),
      renderer.handlers(),
    );
  },
);
