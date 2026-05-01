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

/**
 * Cross-platform "is this file safe to read sensitive material from?" check.
 *
 * On POSIX, replicates the long-standing `(stat.mode & 0o077) !== 0` rule —
 * any group or other access bit fails the check.
 *
 * On Windows, NTFS does not honour POSIX modes, so we shell out to PowerShell
 * `Get-Acl` and walk each ACE looking for **Allow** rules that grant readable
 * rights (Read / ReadAndExecute / FullControl) to a small set of broad
 * principals (Everyone, Authenticated Users, Anonymous Logon, BUILTIN\Users,
 * and their SID forms).
 *
 * What this Windows check intentionally does NOT do:
 * - It does not walk the inheritance chain or evaluate effective access.
 * - It does not honour Deny ACEs (an explicit Deny that overrides the broad
 *   Allow will still be flagged here).
 * - It does not inspect alternate data streams.
 * - It does not resolve nested group memberships.
 *
 * The intent is to match the bar set by the POSIX check: if a file is broadly
 * readable in an obvious way, refuse to use it for vault key material.
 * Operators who need finer-grained control should adjust ACLs and re-run.
 */
export type SecurityCheckResult = { ok: true } | {
  ok: false;
  reason: string;
};

/**
 * Broad principals on Windows whose Read-style access marks a file as
 * unsafe for sensitive material. Both the localised name and the SID
 * form are recognised so the check works on locale variants of Windows.
 */
const BROAD_WINDOWS_PRINCIPALS: ReadonlyArray<{ name: string; sid: string }> = [
  { name: "Everyone", sid: "S-1-1-0" },
  { name: "NT AUTHORITY\\Anonymous Logon", sid: "S-1-5-7" },
  { name: "NT AUTHORITY\\Authenticated Users", sid: "S-1-5-11" },
  { name: "BUILTIN\\Users", sid: "S-1-5-32-545" },
];

/**
 * Read-granting FileSystemRights tokens. PowerShell renders this property
 * as a comma-separated list (e.g. "Read, Synchronize"), so we substring
 * match across the rendered string rather than parse the bitmask.
 */
const READ_GRANTING_RIGHTS = [
  "FullControl",
  "ReadAndExecute",
  "Read",
] as const;

/**
 * One entry in a `(Get-Acl).Access` array. Only the fields we read are
 * declared; PowerShell emits more (e.g. `IsInherited`, `InheritanceFlags`)
 * but they don't influence this check.
 */
interface AclAccessEntry {
  FileSystemRights?: string | number;
  AccessControlType?: string | number;
  IdentityReference?: { Value?: string } | string;
}

/**
 * Verifies that the file at `path` is not broadly readable.
 *
 * - Returns `{ ok: true }` when the file is restricted to the owner.
 * - Returns `{ ok: false, reason }` when the file is broadly readable; the
 *   reason is suitable for surfacing directly in an error message.
 */
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
  // We pass the path through PowerShell single-quote escaping. PowerShell
  // single-quoted strings escape an embedded `'` as `''`. We refuse paths
  // that contain other characters PowerShell can't safely round-trip
  // through Get-Acl (NUL, CR/LF) — fail closed.
  if (path.includes("\0") || path.includes("\r") || path.includes("\n")) {
    return {
      ok: false,
      reason:
        `Could not verify ACL for '${path}': path contains unsupported characters`,
    };
  }
  const escapedPath = path.replaceAll("'", "''");

  let output: { code: number; stdout: string; stderr: string };
  try {
    const cmd = new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Acl -LiteralPath '${escapedPath}').Access | ConvertTo-Json -Compress`,
      ],
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
        `Could not verify ACL for '${path}': PowerShell Get-Acl exited with code ${output.code}: ${
          output.stderr.trim() || "<no stderr>"
        }`,
    };
  }

  const trimmed = output.stdout.trim();
  // Empty stdout means there are no ACEs — surprising, but treat as a
  // verification failure rather than silently passing.
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason:
        `Could not verify ACL for '${path}': PowerShell Get-Acl returned no access entries`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      reason:
        `Could not verify ACL for '${path}': failed to parse Get-Acl JSON output: ${
          error instanceof Error ? error.message : String(error)
        }`,
    };
  }

  // ConvertTo-Json renders a single-element array as the bare object.
  // Normalise to an array so the walk is uniform.
  const entries: AclAccessEntry[] = Array.isArray(parsed)
    ? (parsed as AclAccessEntry[])
    : [parsed as AclAccessEntry];

  for (const ace of entries) {
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
 * Returns the matched broad principal name when an ACE grants readable
 * rights to a broad principal, or null when the ACE is acceptable.
 */
function matchBroadAce(ace: AclAccessEntry): string | null {
  // AccessControlType: "Allow" (0) or "Deny" (1). PowerShell stringifies
  // it for non-compressed JSON but with -Compress it can render as the
  // numeric enum value. Accept both.
  const aceTypeRaw = ace.AccessControlType;
  const isAllow = aceTypeRaw === "Allow" || aceTypeRaw === 0;
  if (!isAllow) return null;

  const identity = extractIdentity(ace.IdentityReference);
  if (identity === null) return null;

  const matched = BROAD_WINDOWS_PRINCIPALS.find((p) =>
    identity.localeCompare(p.name, undefined, { sensitivity: "accent" }) ===
      0 ||
    identity === p.sid
  );
  if (!matched) return null;

  // Rights: PowerShell may render either a comma-joined name string
  // ("Read, Synchronize") or, with -Compress, sometimes the integer
  // bitmask. We only flag on the string form's broad-read tokens; if
  // the value is a number we conservatively flag any non-zero value as
  // a Read-or-better grant from a broad principal.
  const rights = ace.FileSystemRights;
  if (typeof rights === "string") {
    if (READ_GRANTING_RIGHTS.some((r) => rights.includes(r))) {
      return matched.name;
    }
    return null;
  }
  if (typeof rights === "number") {
    return rights !== 0 ? matched.name : null;
  }
  return null;
}

function extractIdentity(
  identity: AclAccessEntry["IdentityReference"],
): string | null {
  if (typeof identity === "string") return identity;
  if (identity && typeof identity === "object" && "Value" in identity) {
    return identity.Value ?? null;
  }
  return null;
}
