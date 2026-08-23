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

// Unit-test hygiene ratchet (see CLAUDE.md, Testing).
//
// Unit tests in src/ must not spawn subprocesses or bind sockets: real
// processes and ports are the main source of test flakiness (port
// collisions, zombie children, platform-dependent binaries) and of slow
// suites. The boundary belongs behind a mock — `withMockedCommand` /
// `withMockedFetch` from packages/testing — and tests that genuinely need
// a real process or a real socket are acceptance tests and belong in
// swamp-uat.
//
// The narrow exception is an infrastructure *adapter* test: when the unit
// under test IS the process/socket adapter (an HTTP client, a git wrapper,
// a signal handler), exercising the real boundary is the point. Every such
// file is pinned below with a one-line justification. The pin is exact-set
// both ways (see assertPinnedSet): a new offender fails the test, and a
// cleaned-up file must be removed from the list so it cannot regress.

import { walk } from "@std/fs/walk";
import {
  assertPinnedSet,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

/**
 * The process- and socket-level Deno APIs a unit test must not reach for.
 * Matched as real code after comments and string literals are stripped.
 */
const FORBIDDEN_API_PATTERN =
  /\bDeno\s*\.\s*(Command|run|serve|listen|listenTls)\s*\(/;

/**
 * Blank out comments and string literals so a test that merely *mentions*
 * one of the forbidden APIs — in a test name, a fixture string, or a
 * comment — is not flagged. Pragmatic single-pass scanner, not a full
 * lexer: regex literals and template-literal `${}` interpolations are
 * treated as opaque text, so a forbidden call inside a template
 * interpolation would be missed. That trade-off is acceptable here — the
 * pinned set below absorbs any edge case either way, and a miss cannot
 * un-pin an existing entry.
 */
function stripCommentsAndStrings(source: string): string {
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let state: State = "code";
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    switch (state) {
      case "code":
        if (ch === "/" && next === "/") {
          state = "line";
          out += "  ";
          i++;
        } else if (ch === "/" && next === "*") {
          state = "block";
          out += "  ";
          i++;
        } else if (ch === "'") {
          state = "single";
          out += " ";
        } else if (ch === '"') {
          state = "double";
          out += " ";
        } else if (ch === "`") {
          state = "template";
          out += " ";
        } else {
          out += ch;
        }
        break;
      case "line":
        if (ch === "\n") {
          state = "code";
          out += ch;
        } else {
          out += " ";
        }
        break;
      case "block":
        if (ch === "*" && next === "/") {
          state = "code";
          out += "  ";
          i++;
        } else {
          out += ch === "\n" ? ch : " ";
        }
        break;
      case "single":
      case "double": {
        const quote = state === "single" ? "'" : '"';
        if (ch === "\\") {
          out += "  ";
          i++;
        } else if (ch === quote) {
          state = "code";
          out += " ";
        } else {
          // A newline inside a plain string is a syntax error anyway;
          // recover to code so one bad literal cannot blank a whole file.
          out += ch === "\n" ? ch : " ";
          if (ch === "\n") state = "code";
        }
        break;
      }
      case "template":
        if (ch === "\\") {
          out += "  ";
          i++;
        } else if (ch === "`") {
          state = "code";
          out += " ";
        } else {
          out += ch === "\n" ? ch : " ";
        }
        break;
    }
  }
  return out;
}

// Pinned allowlist: every src/ test file that spawns a subprocess or binds
// a socket today, each with its reason for existing. Adapter tests for the
// process/socket boundary itself are the accepted category; the rest are
// legacy debt that should migrate to mocks or to swamp-uat, and this list
// may shrink but never grow.
const PINNED_SUBPROCESS_SOCKET_TESTS: readonly string[] = [
  // In-process Deno.serve WebSocket stands in for the swamp server that
  // the command's --server path talks to.
  "src/cli/commands/access_can_i_test.ts",
  // In-process Deno.serve WebSocket stands in for the swamp server that
  // the command's --server path talks to.
  "src/cli/commands/access_check_test.ts",
  // In-process Deno.serve WebSocket stands in for the swamp server that
  // the command's --server path talks to.
  "src/cli/commands/access_grant_test.ts",
  // In-process Deno.serve WebSocket stands in for the swamp server that
  // the command's --server path talks to.
  "src/cli/commands/access_group_test.ts",
  // Spawns the CLI via Deno.execPath() to exercise `swamp config` end-to-end.
  "src/cli/commands/config_test.ts",
  // Spawns a deno subprocess to exercise the doctor audit path end-to-end.
  "src/cli/commands/doctor_audit_test.ts",
  // Runs real `git init` to build repository fixtures for context detection.
  "src/cli/context_test.ts",
  // In-process Deno.serve WebSocket stands in for the swamp server that
  // the command's --server path talks to.
  "src/cli/commands/model_validate_test.ts",
  // In-process Deno.serve WebSocket stands in for the swamp server that
  // the command's --server path talks to.
  "src/cli/commands/worker_verify_test.ts",
  // In-process Deno.serve WebSocket stands in for the swamp server that
  // the command's --server path talks to.
  "src/cli/commands/workflow_resume_test.ts",
  // Deno.serve stands in for the remote swamp server the command talks to.
  "src/cli/remote_run_test.ts",
  // Runs Windows `icacls` to verify on-disk ACLs the provider must set.
  "src/domain/vaults/local_encryption_vault_provider_test.ts",
  // Spawns a deno subprocess to verify summary output of a real run.
  "src/domain/workflows/workflow_run_summary_test.ts",
  // HTTP adapter test: real localhost server is the boundary under test.
  "src/infrastructure/http/extension_api_client_test.ts",
  // HTTP adapter test: real localhost server is the boundary under test.
  "src/infrastructure/http/swamp_club_client_search_test.ts",
  // HTTP adapter test: real localhost server is the boundary under test.
  "src/infrastructure/http/swamp_club_client_test.ts",
  // Spawns a second deno process to prove cross-process catalog locking.
  "src/infrastructure/persistence/catalog_store_test.ts",
  // Spawns a second deno process to prove cross-process sync coordination.
  "src/infrastructure/persistence/datastore_sync_coordinator_test.ts",
  // git adapter test: the unit under test wraps the real git binary.
  "src/infrastructure/persistence/git_worktree_test.ts",
  // Spawns a deno child to deliver real OS signals to shutdown handlers.
  "src/infrastructure/process/shutdown_handlers_test.ts",
  // Runtime adapter test: spawning deno is the behaviour under test.
  "src/infrastructure/runtime/embedded_deno_runtime_test.ts",
  // Runs `openssl` to mint throwaway certificates for TLS validation.
  "src/infrastructure/runtime/tls_cert_validation_test.ts",
  // Runs Windows `icacls` to verify the file-permission checks.
  "src/infrastructure/security/file_security_check_test.ts",
  // Runs `tar` to build archives and serves them from a localhost server.
  "src/infrastructure/source/http_source_downloader_test.ts",
  // HTTP adapter test: real localhost server is the boundary under test.
  "src/infrastructure/telemetry/http_telemetry_sender_test.ts",
  // Localhost server plus `xattr` to verify quarantine-flag handling.
  "src/infrastructure/update/http_update_checker_test.ts",
  // Runs `tar` to verify the push/pull bundle round-trip byte-for-byte.
  "src/libswamp/extensions/push_pull_roundtrip_test.ts",
  // OAuth adapter test: real localhost server drives the token flows.
  "src/serve/oauth_client_test.ts",
];

Deno.test(
  "unit test hygiene: src/ tests that spawn subprocesses or bind sockets match the pinned allowlist",
  async () => {
    const offenders: string[] = [];
    for await (
      const entry of walk(SRC_DIR, {
        exts: [".ts", ".tsx"],
        includeDirs: false,
        match: [/_test\.tsx?$/],
      })
    ) {
      const source = await Deno.readTextFile(entry.path);
      if (FORBIDDEN_API_PATTERN.test(stripCommentsAndStrings(source))) {
        offenders.push(repoRelative(entry.path));
      }
    }

    assertPinnedSet(
      offenders.sort(),
      PINNED_SUBPROCESS_SOCKET_TESTS,
      "Unit tests spawning subprocesses or binding sockets",
      "Unit tests in src/ must not spawn subprocesses or bind sockets\n" +
        "(CLAUDE.md, Testing). Mock the boundary instead — withMockedCommand /\n" +
        "withMockedFetch from packages/testing — or, if the test genuinely\n" +
        "needs a real process or socket, it is an acceptance test and belongs\n" +
        "in swamp-uat. Only a true infrastructure adapter test (the unit under\n" +
        "test IS the process/socket boundary) may be added to the pinned list,\n" +
        "with a one-line justification comment.",
    );
  },
);
