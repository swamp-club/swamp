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

import { UserError } from "../../domain/errors.ts";

// a late bind failure would come after replay started runs, so --reuse-port
// checks the port and the TLS pair before startup does any work
export function checkReusePortListen(options: {
  port: number;
  hostname: string;
  cert?: string;
  key?: string;
}): void {
  try {
    Deno.listen({
      port: options.port,
      hostname: options.hostname,
      reusePort: true,
    }).close();
  } catch (error) {
    throw new UserError(
      `--reuse-port: cannot listen on ${options.hostname}:${options.port} (${
        error instanceof Error ? error.message : String(error)
      }); a process listening there without --reuse-port blocks an overlapping start`,
    );
  }
  if (options.cert !== undefined && options.key !== undefined) {
    try {
      Deno.listenTls({
        port: 0,
        hostname: "127.0.0.1",
        cert: options.cert,
        key: options.key,
      }).close();
    } catch (error) {
      throw new UserError(
        `--reuse-port: the TLS certificate and key do not load (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }
}
