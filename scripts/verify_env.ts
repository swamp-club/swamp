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

import { join } from "@std/path";

/** Where verification credentials live, by convention. */
export const VERIFY_ENV_PATH = ".config/swamp/verify.env";

/**
 * Parse a dotenv-style file into key/value pairs.
 *
 * Deliberately small: blank lines and `#` comments are skipped, an optional
 * leading `export ` is tolerated, and a single layer of matching quotes is
 * stripped. Anything more (interpolation, multi-line values) is not supported,
 * because a credential file that needs it is a sign the credential belongs in
 * a vault rather than here.
 */
export function parseEnvFile(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Populate the named variables from `~/.config/swamp/verify.env` when they are
 * not already set, and report which ones came from the file.
 *
 * Verification steps inherit whatever environment launched them, so a run
 * started from a shell that never exported these credentials failed in ways
 * that pointed nowhere near the cause: skill review exited in milliseconds
 * claiming the token "is not set", while its own error told the operator to
 * put the token in this very file — which nothing read. Loading it here makes
 * that message true and makes the launcher irrelevant, whether it is an
 * interactive shell, an agent, cron, or a remote worker.
 *
 * An already-set variable always wins, so an explicit export still overrides
 * the file. Names are passed in rather than loading the whole file because
 * these scripts run under a narrow `--allow-env` allowlist: setting a variable
 * outside it throws, and a credential file may hold keys this script has no
 * business touching.
 */
export function loadVerifyEnv(names: readonly string[]): string[] {
  // Reading HOME needs it inside this script's --allow-env allowlist. A
  // caller that grants only its credential names would otherwise throw here,
  // breaking the step this helper exists to rescue.
  let home: string | undefined;
  try {
    home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  } catch {
    return [];
  }
  if (!home) return [];

  let source: string;
  try {
    source = Deno.readTextFileSync(join(home, VERIFY_ENV_PATH));
  } catch {
    // No file, or unreadable: the caller reports its own missing-credential
    // error, which is clearer than anything this could say.
    return [];
  }

  const parsed = parseEnvFile(source);
  const loaded: string[] = [];
  for (const name of names) {
    if (Deno.env.get(name)) continue;
    const value = parsed[name];
    if (!value) continue;
    try {
      Deno.env.set(name, value);
      loaded.push(name);
    } catch {
      // Outside this script's --allow-env allowlist. Skipping keeps the
      // narrow grant meaningful instead of demanding a broader one.
    }
  }
  return loaded;
}
