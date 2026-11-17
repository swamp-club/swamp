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

import type { ServeId } from "../../domain/serve/managed_serve.ts";
import type { ListenedServe } from "../listening_line.ts";

export interface ServeChildSpec {
  readonly id: ServeId;
  readonly repoDir: string;
  /** the child's public address, passed as --address */
  readonly address: string;
  /** the host's public name, passed as --trusted-hosts */
  readonly trustedHost: string;
  /** the child's whole environment; nothing is inherited from the host */
  readonly env: Readonly<Record<string, string>>;
  /** overrides the supervisor's stop grace for a repo with a longer drain */
  readonly stopGraceMs?: number;
}

/** `code` is null when the child died by a signal or could not be spawned. */
export interface ServeChildExit {
  readonly code: number | null;
  readonly stderrTail: readonly string[];
}

export interface ServeChild {
  /** rejects when the child exits before its listening line */
  readonly listening: Promise<ListenedServe>;
  /** rejects when the child exits or is released before /ready answers 200 */
  readonly ready: Promise<void>;
  /** never rejects */
  readonly exited: Promise<ServeChildExit>;
  /** asks the child to drain and exit */
  terminate(): void;
  /** as SIGHUP reloads plain serve */
  reload(): void;
  kill(): void;
  /** closes stdin and waits for the child and every reader of its output */
  release(): Promise<void>;
}

export interface ServeProcessPort {
  /** never throws: a child that cannot start exits at once with code null */
  spawn(spec: ServeChildSpec): ServeChild;
}

export function serveChildArgs(spec: ServeChildSpec): string[] {
  return [
    "serve",
    "--json",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--address",
    spec.address,
    "--trusted-hosts",
    spec.trustedHost,
    "--trust-proxy",
    "--exit-on-stdin-close",
    "--repo-dir",
    spec.repoDir,
  ];
}
