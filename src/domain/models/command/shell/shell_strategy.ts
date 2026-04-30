// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { VaultSecretBag } from "../../../vaults/vault_secret_bag.ts";
import { PosixShellStrategy } from "./posix_shell_strategy.ts";

/**
 * Per-host abstraction over the shell that runs `command/shell` model
 * invocations.
 *
 * Today every platform selects `PosixShellStrategy` (`sh -c <cmd>`) —
 * including native Windows, where the GitHub Actions runner image
 * bundles Git Bash and most dev machines have it as well. This PR
 * introduces only the seam; the next PR adds a `PowerShellStrategy`
 * and switches selection on native Windows hosts so the .exe doesn't
 * depend on Git Bash being installed.
 *
 * Each strategy owns the executable + args used to wrap a user-authored
 * command string, and the secret-bag resolution that fits the shell's
 * variable expansion and quoting rules.
 */
export interface ShellStrategy {
  /**
   * Build the executable + args that wrap a user-authored command
   * string in the host shell. The returned shape is what
   * `Deno.Command` consumes via `executeProcess`.
   */
  buildInvocation(command: string): {
    command: string;
    args: string[];
  };

  /**
   * Replace vault sentinels in `command` with shell-appropriate
   * environment variable references, returning the rewritten command
   * and the env map of secret values to inject.
   *
   * The env map's keys are the variable names referenced from the
   * rewritten command; the values are the raw secret strings.
   */
  resolveSecrets(
    command: string,
    secretBag: VaultSecretBag,
  ): { command: string; env: Record<string, string> };
}

/**
 * Pick the shell strategy for the current host OS.
 *
 * Always returns `PosixShellStrategy` today. The next PR will route
 * `Deno.build.os === "windows"` to a real PowerShell strategy.
 */
export function selectShellStrategy(): ShellStrategy {
  return new PosixShellStrategy();
}
