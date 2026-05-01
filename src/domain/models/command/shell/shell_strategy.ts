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
import { PowerShellStrategy } from "./powershell_strategy.ts";

/**
 * Per-host abstraction over the shell that runs `command/shell` model
 * invocations. Selection is host-OS driven:
 *
 *   - POSIX (Linux, macOS, WSL) → `PosixShellStrategy` (`sh -c <cmd>`)
 *   - Native Windows .exe       → `PowerShellStrategy`
 *     (`powershell.exe -NoProfile -Command <cmd>`)
 *
 * Each strategy owns the executable + args used to wrap a user-authored
 * command string, and the secret-bag resolution that fits the shell's
 * variable expansion and quoting rules.
 *
 * Users authoring POSIX scripts who want them to run on Windows should
 * run swamp under WSL2 — inside WSL the host OS is `linux` and
 * `PosixShellStrategy` is selected automatically.
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
 * Cached by module-load — host OS doesn't change at runtime.
 */
export function selectShellStrategy(): ShellStrategy {
  if (Deno.build.os === "windows") {
    return new PowerShellStrategy();
  }
  return new PosixShellStrategy();
}
