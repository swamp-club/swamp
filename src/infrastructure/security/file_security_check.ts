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

/**
 * Windows uses icacls (Get-Acl does not load reliably on CI) and flags broad
 * principals only, ignoring inheritance, Deny ACEs, streams and nested groups,
 * matching the POSIX bar of obviously broad readability
 */
export type SecurityCheckResult = { ok: true } | {
  ok: false;
  reason: string;
};

/**
 * icacls prints the localised name or, when the SID cannot be resolved, the
 * SID, so either form is matched
 */
const BROAD_WINDOWS_PRINCIPALS: ReadonlyArray<{ name: string; sid: string }> = [
  { name: "Everyone", sid: "S-1-1-0" },
  { name: "NT AUTHORITY\\Anonymous Logon", sid: "S-1-5-7" },
  { name: "NT AUTHORITY\\Authenticated Users", sid: "S-1-5-11" },
  { name: "BUILTIN\\Users", sid: "S-1-5-32-545" },
];

/**
 * F, M, RX and R grant read-or-better; GR/GE/GA are generic-rights aliases
 * icacls emits when SDDL set the ACL, treated the same
 */
const READ_GRANTING_TOKENS = [
  "(F)",
  "(M)",
  "(RX)",
  "(R)",
  "(GR)",
  "(GE)",
  "(GA)",
] as const;

export async function checkFileNotBroadlyReadable(
  path: string,
): Promise<SecurityCheckResult> {
  if (Deno.build.os === "windows") {
    return await checkWindowsAcl(path);
  }
  return await checkPosixMode(path);
}

async function checkPosixMode(path: string): Promise<SecurityCheckResult> {
  const stat = await Deno.stat(path);
  // Some filesystems (rarely) return null mode — treat as ok and let the
  // caller's downstream logic handle the file. Matches prior behaviour.
  if (stat.mode === null) return { ok: true };
  if ((stat.mode & 0o077) !== 0) {
    const octal = "0o" + (stat.mode & 0o777).toString(8);
    return {
      ok: false,
      reason: `'${path}' has insecure permissions (${octal}). ` +
        `Expected permissions no wider than 0o600. ` +
        `Run 'chmod 600 ${path}' to fix.`,
    };
  }
  return { ok: true };
}

async function checkWindowsAcl(path: string): Promise<SecurityCheckResult> {
  // icacls accepts the path as a positional argument. We refuse paths with
  // NUL/CR/LF defensively — these would corrupt our line-based parse and
  // can't reach a real file via Win32 path syntax anyway.
  if (path.includes("\0") || path.includes("\r") || path.includes("\n")) {
    return {
      ok: false,
      reason:
        `Could not verify ACL for '${path}': path contains unsupported characters`,
    };
  }

  let output: { code: number; stdout: string; stderr: string };
  try {
    const cmd = new Deno.Command("icacls", {
      args: [path],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    output = {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Could not verify ACL for '${path}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (output.code !== 0) {
    return {
      ok: false,
      reason:
        `Could not verify ACL for '${path}': icacls exited with code ${output.code}: ${
          output.stderr.trim() || output.stdout.trim() || "<no output>"
        }`,
    };
  }

  const aces = parseIcaclsOutput(output.stdout, path);
  if (aces.length === 0) {
    return {
      ok: false,
      reason:
        `Could not verify ACL for '${path}': icacls returned no access entries`,
    };
  }

  for (const ace of aces) {
    const broad = matchBroadAce(ace);
    if (broad !== null) {
      return {
        ok: false,
        reason: `'${path}' has insecure ACL: ` +
          `principal '${broad}' has Read or higher access. ` +
          `Remove that ACE (e.g. ` +
          `\`icacls "${path}" /remove:g "${broad}"\`) to restrict the file ` +
          `to its owner.`,
      };
    }
  }

  return { ok: true };
}

/**
 * exported only for unit tests of the parser on non-Windows hosts; production
 * code reaches it through checkFileNotBroadlyReadable
 */
export interface IcaclsAce {
  principal: string;
  rights: string;
}

export function parseIcaclsOutput(stdout: string, path: string): IcaclsAce[] {
  const aces: IcaclsAce[] = [];
  const lines = stdout.split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine;
    if (line.startsWith(path)) {
      line = line.slice(path.length);
    } else if (line.toLowerCase().startsWith(path.toLowerCase())) {
      line = line.slice(path.length);
    }
    line = line.trim();
    if (line.length === 0) continue;
    // localised Windows summary lines differ, so skip any line without a (...)
    // rights token
    if (!line.includes("(") || !line.includes(")")) continue;

    // split on the last `:(` so a colon inside the principal or the leading
    // path does not confuse the split
    const colonIdx = line.lastIndexOf(":(");
    if (colonIdx < 0) continue;
    const principal = line.slice(0, colonIdx).trim();
    const rights = line.slice(colonIdx + 1).trim();
    if (principal.length === 0 || rights.length === 0) continue;

    aces.push({ principal, rights });
  }
  return aces;
}

export function matchBroadAce(ace: IcaclsAce): string | null {
  const matched = BROAD_WINDOWS_PRINCIPALS.find((p) =>
    ace.principal.localeCompare(p.name, undefined, {
        sensitivity: "accent",
      }) === 0 ||
    ace.principal === p.sid
  );
  if (!matched) return null;

  // substring match, since rights may carry inline inheritance flags like
  // (OI)(CI)(R)
  if (READ_GRANTING_TOKENS.some((t) => ace.rights.includes(t))) {
    return matched.name;
  }
  return null;
}
