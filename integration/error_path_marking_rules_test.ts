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

// Architectural fitness test: errors that name a filesystem path mark it
// (swamp-club#2830).
//
// Telemetry removes marked paths exactly (`markErrorPaths` in
// src/domain/errors.ts); an unmarked path falls back to patterns that cannot
// tell where a path with a space in its last segment ends. This ratchet finds
// `new UserError(` / `new Error(` / `new SyntaxError(` whose message
// interpolates a path-named value (`*Path`, `*Dir`, `*File`, `*Root`, `path`,
// `dir`, `file`, `root`, `location`) and is not wrapped in `markErrorPaths(`.
// It is a heuristic: it guards against new unmarked sites, it does not prove
// every path is marked. It does not see messages built by string
// concatenation (`"... at " + path`), messages built before the constructor
// call, or custom error subclasses, and a path in a variable with some other
// name passes.

import { join } from "@std/path";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
} from "./arch_fitness_helpers.ts";

const SRC_DIR = join(import.meta.dirname!, "..", "src");

/** How far before `new` to look for the `markErrorPaths(` wrapper. */
const LOOKBACK = 64;

const CONSTRUCTOR_RE = /\bnew (?:UserError|Error|SyntaxError)\(/g;
const INTERPOLATION_RE = /\$\{([^}]*)\}/g;
const PATH_NAME_RE =
  /^(?:\w+(?:Path|Dir|File|Root)|path|dir|file|root|location)$/;

/** The text between the `(` at `open` and its matching `)`. */
function argumentsAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

function namesPath(args: string): boolean {
  for (const [, expr] of args.matchAll(INTERPOLATION_RE)) {
    for (const token of expr.split(/[^\w]+/)) {
      if (PATH_NAME_RE.test(token)) return true;
    }
  }
  return false;
}

/**
 * Unmarked path-naming error constructions, keyed by file and the start of
 * their message. A repeated key gets an occurrence suffix, so a new copy of
 * an existing message in the same file is still reported.
 */
async function unmarkedPathErrors(): Promise<string[]> {
  const keys: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(filePath);
    const seen = new Map<string, number>();
    for (const match of source.matchAll(CONSTRUCTOR_RE)) {
      const start = match.index!;
      const args = argumentsAt(source, start + match[0].length - 1);
      if (!namesPath(args)) continue;
      const before = source.slice(Math.max(0, start - LOOKBACK), start);
      if (before.trimEnd().endsWith("markErrorPaths(")) {
        continue;
      }
      const message = args.replace(/\s+/g, " ").trim().slice(0, 100);
      const base = `${repoRelative(filePath)}: ${message}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      keys.push(count === 1 ? base : `${base} #${count}`);
    }
  }
  return keys.sort();
}

/**
 * Sites not yet marked. Only remove entries: mark a site's paths with
 * `markErrorPaths` and delete its line here.
 */
const PINNED: readonly string[] = [
  'src/cli/commands/doctor_extensions.ts: `Type "${e.typeNormalized}" (kind=${e.kind}) is claimed by two ` + `installed extensions:\\n` + ` \u2022 $',
  "src/cli/commands/extension_push.ts: `Expected node_modules/ to be a directory at ${nodeModulesPath}. ` + `Run 'npm install' or 'deno ins",
  "src/cli/commands/extension_push.ts: `No node_modules/ found at ${projectDir}. ` + `Run 'npm install' or 'deno install' to install depend",
  "src/cli/commands/extension_report_dispatcher.ts: `No swamp repository found at \\`${repoDir}\\`. ` + `Run \\`swamp issue ...\\` from inside a swamp repo,",
  'src/cli/input_parser.ts: `Input file not found for key "${key}": ${resolvedPath}` + `. Values starting with @ are read as fil',
  "src/cli/input_parser.ts: `Input file not found: ${inputFile}`",
  "src/cli/mod.ts: `--extensions-dir directory not found: ${extensionsDir}`,",
  "src/cli/mod.ts: `--extensions-dir must be a directory: ${extensionsDir}`,",
  "src/cli/remote_run.ts: `${flagName} file is empty: ${path}`",
  "src/cli/remote_run.ts: `${flagName} file not found: ${path}`",
  "src/cli/remote_run.ts: `${flagName} file not readable: ${path}`",
  "src/cli/remote_run.ts: `Could not read CA certificate file '${certPath}': ${detail}`,",
  "src/cli/resolve_extension_files.ts: `Additional file is a symlink: ${af} (at ${afPath}). ` + `Symlinks in additionalFiles are rejected t",
  "src/cli/resolve_extension_files.ts: `Additional file not found: ${af} (expected at ${afPath})`,",
  "src/cli/resolve_extension_files.ts: `Binary file is a symlink: ${bf} (at ${bfPath}). ` + `Symlinks in binaries are rejected to prevent a",
  "src/cli/resolve_extension_files.ts: `Binary file not found: ${bf} (expected at ${bfPath})`,",
  "src/cli/resolve_extension_files.ts: `Datastore file not found: ${datastoreRef} (expected at ${datastorePath})` + monorepoHint,",
  'src/cli/resolve_extension_files.ts: `Expected a manifest path but got a TypeScript/JavaScript file: ${manifestPath}\\n` + "Pass the manif',
  "src/cli/resolve_extension_files.ts: `Include file not found: ${inc} (expected at ${incPath})`,",
  "src/cli/resolve_extension_files.ts: `Manifest field '${field}' contains unsafe path: ${path}. ` + `Paths must be relative and must not c",
  "src/cli/resolve_extension_files.ts: `Manifest file not found: ${absoluteManifestPath}`,",
  "src/cli/resolve_extension_files.ts: `Model file not found: ${modelRef} (expected at ${modelPath})` + monorepoHint,",
  "src/cli/resolve_extension_files.ts: `Report file not found: ${reportRef} (expected at ${reportPath})` + monorepoHint,",
  "src/cli/resolve_extension_files.ts: `Vault file not found: ${vaultRef} (expected at ${vaultPath})` + monorepoHint,",
  "src/cli/resolve_extension_files.ts: `Webhook file not found: ${webhookRef} (expected at ${webhookPath})` + monorepoHint,",
  'src/domain/extensions/extension_file_resolver.ts: `Extension file not found: "${relPath}". This can happen when ` + `the installed archive was package',
  'src/domain/extensions/extension_file_resolver.ts: `Unsafe relative path passed to ctx.extensionFile(): "${relPath}". ` + `Paths must be relative, must',
  "src/domain/models/data_writer.ts: `Cannot store sensitive field '${field.path}': vault '${targetVault}' is reserved for internal use`,",
  "src/infrastructure/assets/skill_assets.ts: `Invalid skill path: ${skill.relativePath} contains path traversal`,",
  'src/infrastructure/http/swamp_club_client.ts: `Request to ${this.serverUrl}${path} timed out after ${seconds}s.`, "timeout",',
  "src/libswamp/auth/server_login.ts: `${serverUrl} returned a response that is not JSON to ${method} ${path} ` + `(HTTP ${resp.status}). ",
  "src/libswamp/auth/server_login.ts: `Could not reach ${serverUrl} (${method} ${path}): ${ describeCauses(err) }`,",
  "src/libswamp/extensions/pull.ts: `Cannot install ${ref.name}: the installed extension ` + `${ref.name}/${relDir} lives at ${first}/ i",
  "src/libswamp/extensions/pull.ts: `Extension has safety errors. Install aborted.\\n${ safetyResult.errors.map((e) => ` ${e.file}: ${e.m",
  "src/serve/serve_config.ts: `Failed to read serve config file ${path}: ${cause}`,",
  "src/serve/serve_config.ts: `Failed to read serve config file ${path}: ${error}`",
  "src/serve/serve_config.ts: `Invalid ${name} in ${path}: expected string, got ${typeof value}`,",
  "src/serve/serve_config.ts: `Invalid ${name} in ${path}: expected string, got ${typeof value}`, #2",
  "src/serve/serve_config.ts: `Invalid ${name} in ${path}: expected string, got ${typeof value}`, #3",
  "src/serve/serve_config.ts: `Invalid YAML in serve config file ${path}: ${cause}`,",
  "src/serve/serve_config.ts: `Invalid YAML in serve config file ${path}: ${cause}`, #2",
  "src/serve/serve_config.ts: `Invalid audit in ${path}: expected mapping`,",
  "src/serve/serve_config.ts: `Invalid audit store at index ${i} in ${path}: config must be an object`,",
  "src/serve/serve_config.ts: `Invalid audit store at index ${i} in ${path}: expected object`,",
  "src/serve/serve_config.ts: `Invalid audit store at index ${i} in ${path}: retention must be an object`,",
  "src/serve/serve_config.ts: `Invalid audit store at index ${i} in ${path}: retention.days must be a positive integer`,",
  "src/serve/serve_config.ts: `Invalid audit store at index ${i} in ${path}: target is required and must be a string`,",
  "src/serve/serve_config.ts: `Invalid audit store at index ${i} in ${path}: type and config must both be present for a dedicated ",
  "src/serve/serve_config.ts: `Invalid audit store at index ${i} in ${path}: type must be a string`,",
  "src/serve/serve_config.ts: `Invalid audit.alerts in ${path}: expected array`,",
  "src/serve/serve_config.ts: `Invalid audit.alerts[${i}] in ${path}: expected object`,",
  "src/serve/serve_config.ts: `Invalid audit.alerts[${i}].action in ${path}: required object`,",
  "src/serve/serve_config.ts: `Invalid audit.alerts[${i}].action.type in ${path}: expected one of webhook, log`,",
  'src/serve/serve_config.ts: `Invalid audit.alerts[${i}].action.url in ${path}: "${action.url}" is not a valid URL`,',
  "src/serve/serve_config.ts: `Invalid audit.alerts[${i}].action.url in ${path}: webhook action requires a url`,",
  "src/serve/serve_config.ts: `Invalid audit.alerts[${i}].match in ${path}: required object`,",
  "src/serve/serve_config.ts: `Invalid audit.alerts[${i}].name in ${path}: required string`,",
  "src/serve/serve_config.ts: `Invalid audit.alerts[${i}].threshold in ${path}: required object`,",
  "src/serve/serve_config.ts: `Invalid audit.alerts[${i}].threshold.count in ${path}: expected positive integer`,",
  "src/serve/serve_config.ts: `Invalid audit.alerts[${i}].threshold.window-seconds in ${path}: expected positive number`,",
  "src/serve/serve_config.ts: `Invalid audit.batch-size in ${path}: expected positive integer`,",
  "src/serve/serve_config.ts: `Invalid audit.fail-open in ${path}: expected boolean`,",
  'src/serve/serve_config.ts: `Invalid audit.flush-interval in ${path}: expected format like "5s", "100ms", or "1m", got "${ obj["',
  'src/serve/serve_config.ts: `Invalid audit.flush-interval in ${path}: expected string (e.g. "5s", "10s"), got ${typeof obj[ "flu',
  'src/serve/serve_config.ts: `Invalid audit.flush-interval in ${path}: must be positive, got "${ obj["flush-interval"] }"`,',
  "src/serve/serve_config.ts: `Invalid audit.hmac in ${path}: expected mapping`,",
  "src/serve/serve_config.ts: `Invalid audit.hmac.enabled in ${path}: expected boolean`,",
  "src/serve/serve_config.ts: `Invalid audit.hmac.key in ${path}: expected string`,",
  "src/serve/serve_config.ts: `Invalid audit.hmac.vault in ${path}: expected string`,",
  "src/serve/serve_config.ts: `Invalid audit.policy in ${path}: expected mapping`,",
  "src/serve/serve_config.ts: `Invalid audit.policy.default-level in ${path}: expected one of none, metadata, request, requestResp",
  "src/serve/serve_config.ts: `Invalid audit.policy.rules in ${path}: expected array`,",
  "src/serve/serve_config.ts: `Invalid audit.policy.rules[${i}] in ${path}: expected object`,",
  "src/serve/serve_config.ts: `Invalid audit.policy.rules[${i}].action in ${path}: expected string`,",
  "src/serve/serve_config.ts: `Invalid audit.policy.rules[${i}].category in ${path}: expected string`,",
  "src/serve/serve_config.ts: `Invalid audit.policy.rules[${i}].hmac in ${path}: expected boolean`,",
  "src/serve/serve_config.ts: `Invalid audit.policy.rules[${i}].level in ${path}: expected one of none, metadata, request, request",
  "src/serve/serve_config.ts: `Invalid audit.policy.rules[${i}].tier in ${path}: expected one of management, data`,",
  "src/serve/serve_config.ts: `Invalid audit.sinks in ${path}: expected array`,",
  "src/serve/serve_config.ts: `Invalid audit.sinks[${i}] in ${path}: expected object`,",
  "src/serve/serve_config.ts: `Invalid audit.sinks[${i}].host in ${path}: syslog sink requires a host`,",
  "src/serve/serve_config.ts: `Invalid audit.sinks[${i}].port in ${path}: syslog sink requires an integer port`,",
  "src/serve/serve_config.ts: `Invalid audit.sinks[${i}].type in ${path}: expected one of webhook, syslog`,",
  'src/serve/serve_config.ts: `Invalid audit.sinks[${i}].url in ${path}: "${s.url}" is not a valid URL`,',
  "src/serve/serve_config.ts: `Invalid audit.sinks[${i}].url in ${path}: webhook sink requires a url`,",
  "src/serve/serve_config.ts: `Invalid audit.stores in ${path}: expected array, got ${typeof obj .stores}`,",
  "src/serve/serve_config.ts: `Invalid audit.wal in ${path}: expected mapping`,",
  "src/serve/serve_config.ts: `Invalid audit.wal.directory in ${path}: expected string`,",
  'src/serve/serve_config.ts: `Invalid audit.wal.max-size in ${path}: expected format like "100MB" or "1GB", got "${ wal["max-size',
  'src/serve/serve_config.ts: `Invalid audit.wal.max-size in ${path}: expected string (e.g. "100MB", "1GB")`,',
  "src/serve/serve_config.ts: `Invalid auth.approve-requires-explicit-grant in ${path}: expected boolean, got ${typeof approveRequ",
  'src/serve/serve_config.ts: `Invalid auto-resume in ${path}: expected boolean, got ${typeof raw[ "auto-resume" ]}`,',
  'src/serve/serve_config.ts: `Invalid detach-runs in ${path}: expected boolean, got ${typeof raw[ "detach-runs" ]}`,',
  "src/serve/serve_config.ts: `Invalid host in ${path}: expected string, got ${typeof raw.host}`,",
  'src/serve/serve_config.ts: `Invalid hot-reload in ${path}: expected boolean, got ${typeof raw[ "hot-reload" ]}`,',
  "src/serve/serve_config.ts: `Invalid port in ${path}: expected integer, got ${ JSON.stringify(raw.port) }`,",
  "src/serve/serve_config.ts: `Invalid port in ${path}: must be between 1 and 65535, got ${raw.port}`,",
  'src/serve/serve_config.ts: `Invalid remote-only in ${path}: expected boolean, got ${typeof raw[ "remote-only" ]}`,',
  "src/serve/serve_config.ts: `Invalid schedule in ${path}: expected boolean, got ${typeof raw .schedule}`,",
  "src/serve/serve_config.ts: `Invalid token-secrets in ${path}: expected mapping with vault and key`,",
  'src/serve/serve_config.ts: `Invalid token-secrets.${field} in ${path}: expected a non-empty ` + "string without surrounding whi',
  "src/serve/serve_config.ts: `Invalid token-secrets.vault in ${path}: the key cannot be stored in ` + `${TOKEN_SECRETS_VAULT_NAME",
  "src/serve/serve_config.ts: `Invalid trigger override for '${workflowName}' in ${path}: expected object with optional 'schedule'",
  "src/serve/serve_config.ts: `Invalid trigger override for '${workflowName}' in ${path}: inputs must be a mapping`,",
  "src/serve/serve_config.ts: `Invalid trigger override for '${workflowName}' in ${path}: invalid cron expression '${obj.schedule}",
  "src/serve/serve_config.ts: `Invalid trigger override for '${workflowName}' in ${path}: must specify at least 'schedule' or 'inp",
  "src/serve/serve_config.ts: `Invalid trigger override for '${workflowName}' in ${path}: schedule must be a string, got ${typeof ",
  "src/serve/serve_config.ts: `Invalid triggers in ${path}: expected mapping of workflow name to trigger override`,",
  'src/serve/serve_config.ts: `Invalid trust-proxy in ${path}: expected boolean, got ${typeof raw[ "trust-proxy" ]}`,',
  'src/serve/serve_config.ts: `Invalid trusted-hosts in ${path}: expected array of strings, got ${typeof raw[ "trusted-hosts" ]}`,',
  'src/serve/serve_config.ts: `Invalid verify-on-enroll in ${path}: expected boolean, got ${typeof raw[ "verify-on-enroll" ]}`,',
  "src/serve/serve_config.ts: `Invalid webhook at index ${index} in ${path}: config is only supported for webhook extension scheme",
  "src/serve/serve_config.ts: `Invalid webhook at index ${index} in ${path}: config must be an object`,",
  "src/serve/serve_config.ts: `Invalid webhook at index ${index} in ${path}: expected object`,",
  "src/serve/serve_config.ts: `Invalid webhook at index ${index} in ${path}: generic scheme requires a header name`,",
  "src/serve/serve_config.ts: `Invalid webhook at index ${index} in ${path}: route is required and must be a string`,",
  "src/serve/serve_config.ts: `Invalid webhook at index ${index} in ${path}: route must start with '/', got '${obj.route}'`,",
  'src/serve/serve_config.ts: `Invalid webhook at index ${index} in ${path}: scheme must be one of ${ WEBHOOK_SCHEMES.join(", ") }',
  "src/serve/serve_config.ts: `Invalid webhook at index ${index} in ${path}: secret is required and must be a string`,",
  "src/serve/serve_config.ts: `Invalid webhook at index ${index} in ${path}: workflow is required and must be a string`,",
  "src/serve/serve_config.ts: `Invalid webhooks in ${path}: expected array, got ${typeof raw .webhooks}`,",
  'src/serve/serve_config.ts: `Serve config file ${path} must be a YAML mapping, got ${ Array.isArray(parsed) ? "array" : typeof p',
  'src/serve/serve_config.ts: `Serve config file ${path} must be a YAML mapping, got ${ Array.isArray(parsed) ? "array" : typeof p #2',
  "src/serve/serve_config.ts: `Serve config file not found: ${path}`,",
  "src/worker/data_plane_client.ts: `Data plane ${method} ${path} failed (${response.status}): ${detail}`,",
];

Deno.test("error path marking: no new unmarked path-naming errors", async () => {
  assertPinnedSet(
    await unmarkedPathErrors(),
    PINNED,
    "Unmarked path-naming errors",
    "Wrap the new error in markErrorPaths(error, [thePath]) so telemetry " +
      "removes the path exactly (swamp-club#2830). If the value is not a " +
      "filesystem path, rename it or pin the entry with a reason.",
  );
});
