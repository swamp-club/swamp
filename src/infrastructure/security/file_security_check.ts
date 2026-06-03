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
 * Cross-platform "is this file safe to read sensitive material from?" check.
 *
 * On POSIX, replicates the long-standing `(stat.mode & 0o077) !== 0` rule —
 * any group or other access bit fails the check.
 *
 * On Windows, NTFS does not honour POSIX modes, so we shell out to `icacls`
 * and walk each ACE looking for entries that grant readable rights to a small
 * set of broad principals (Everyone, Authenticated Users, Anonymous Logon,
 * BUILTIN\Users). We use `icacls` rather than PowerShell `Get-Acl` because
 * GitHub Actions windows-latest runners cannot reliably auto-load the
 * `Microsoft.PowerShell.Security` module that hosts `Get-Acl`, but `icacls`
 * is a native Win32 binary that is always present.
 *
 * What this Windows check intentionally does NOT do:
 * - It does not walk the inheritance chain or evaluate effective access.
 * - It does not honour Deny ACEs (an explicit Deny that overrides a broad
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
 * unsafe for sensitive material. icacls renders both the localised name
 * and (when the SID cannot be resolved) the SID itself, so we match
 * either form.
 */
const BROAD_WINDOWS_PRINCIPALS: ReadonlyArray<{ name: string; sid: string }> = [
  { name: "Everyone", sid: "S-1-1-0" },
  { name: "NT AUTHORITY\\Anonymous Logon", sid: "S-1-5-7" },
  { name: "NT AUTHORITY\\Authenticated Users", sid: "S-1-5-11" },
  { name: "BUILTIN\\Users", sid: "S-1-5-32-545" },
];

/**
 * icacls permission tokens that grant read-or-better access. These appear
 * inside parentheses on each ACE line, e.g. `(R)`, `(RX)`, `(F)`, `(M)`.
 * - F  = Full control
 * - M  = Modify (implies Read)
 * - RX = Read and Execute
 * - R  = Read
 * GR/GE/GA are generic-rights aliases icacls also emits when SDDL was used
 * to set the ACL — we treat those equivalently.
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
 * Parsed icacls ACE. Exported for direct unit testing of the parser on
 * non-Windows hosts; production code only consumes it via
 * `checkFileNotBroadlyReadable`.
 *
 * @internal
 */
export interface IcaclsAce {
  /** Principal as printed by icacls, e.g. "Everyone" or "BUILTIN\\Users". */
  principal: string;
  /** Raw rights string, e.g. "(R)" or "(OI)(CI)(F)". */
  rights: string;
}

/**
 * Parses `icacls <path>` output into a list of ACEs.
 *
 * icacls output looks like (one ACE may span multiple lines if rights are
 * inheritance-flagged):
 *
 *   C:\path\to\file Everyone:(R)
 *                   BUILTIN\Users:(RX)
 *                   BUILTIN\Administrators:(F)
 *                   DOMAIN\user:(F)
 *
 *   Successfully processed 1 files; Failed processing 0 files
 *
 * The first ACE on the first line is preceded by the file path (which may
 * contain spaces). On continuation lines the file path is replaced by
 * leading whitespace. The trailing summary line ("Successfully processed
 * ...") is not an ACE.
 *
 * We split each ACE on the LAST `:` so that principals like
 * `BUILTIN\Users` (no colon) and `DOMAIN\user` (no colon) parse correctly,
 * and so a path like `C:\foo` on the leading line doesn't confuse us — we
 * strip the path prefix before splitting.
 *
 * @internal — exported only so unit tests can exercise the parser on
 * non-Windows hosts. Production code calls `checkFileNotBroadlyReadable`.
 */
export function parseIcaclsOutput(stdout: string, path: string): IcaclsAce[] {
  const aces: IcaclsAce[] = [];
  // Normalise EOL — icacls emits CRLF on Windows but we may run under
  // tests that mock the binary on POSIX.
  const lines = stdout.split(/\r?\n/);
  for (const rawLine of lines) {
    // Strip the leading path prefix if present. icacls prints the file
    // path verbatim on the first ACE line; we strip it whether it's the
    // exact path passed in (case-insensitive) or just leading whitespace.
    let line = rawLine;
    if (line.startsWith(path)) {
      line = line.slice(path.length);
    } else if (line.toLowerCase().startsWith(path.toLowerCase())) {
      // icacls may normalise the path's case — handle that.
      line = line.slice(path.length);
    }
    line = line.trim();
    if (line.length === 0) continue;
    // Skip the trailing summary line. The English form starts with
    // "Successfully processed", but localised Windows can return other
    // strings — the discriminator we lean on is the absence of any
    // "(...)" rights token.
    if (!line.includes("(") || !line.includes(")")) continue;

    // Split on the LAST `:` so principals containing `:` (which is rare
    // but possible) don't trip us; in practice icacls separates
    // principal:rights with a single `:` and rights are wrapped in
    // parentheses, so the colon immediately before "(" is the separator.
    const colonIdx = line.lastIndexOf(":(");
    if (colonIdx < 0) continue;
    const principal = line.slice(0, colonIdx).trim();
    const rights = line.slice(colonIdx + 1).trim();
    if (principal.length === 0 || rights.length === 0) continue;

    aces.push({ principal, rights });
  }
  return aces;
}

/**
 * Returns the matched broad principal name when an ACE grants readable
 * rights to a broad principal, or null when the ACE is acceptable.
 *
 * @internal — exported only so unit tests can exercise the matcher on
 * non-Windows hosts.
 */
export function matchBroadAce(ace: IcaclsAce): string | null {
  const matched = BROAD_WINDOWS_PRINCIPALS.find((p) =>
    ace.principal.localeCompare(p.name, undefined, {
        sensitivity: "accent",
      }) === 0 ||
    ace.principal === p.sid
  );
  if (!matched) return null;

  // Substring-match across the rights string. icacls may emit
  // inheritance flags inline (e.g. "(OI)(CI)(R)") so we don't anchor on
  // the start/end of the string.
  if (READ_GRANTING_TOKENS.some((t) => ace.rights.includes(t))) {
    return matched.name;
  }
  return null;
}
