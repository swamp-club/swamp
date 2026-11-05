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

import { walk } from "@std/fs/walk";
import {
  assertPinnedSet,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const FORBIDDEN_API_PATTERN =
  /\bDeno\s*\.\s*(Command|run|serve|listen|listenTls)\s*\(/;

/**
 * single-pass scanner, not a full lexer: a forbidden call inside a template
 * interpolation is missed, which the pinned set absorbs
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
          // a newline in a plain string is a syntax error anyway; recover to
          // code so one bad literal cannot blank a whole file
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

// every src/ test that spawns a subprocess or binds a socket; adapter tests are
// accepted, the rest is debt to migrate, and the list may shrink but never grow
const PINNED_SUBPROCESS_SOCKET_TESTS: readonly string[] = [
  "src/cli/commands/access_can_i_test.ts",
  "src/cli/commands/access_check_test.ts",
  "src/cli/commands/access_grant_test.ts",
  "src/cli/commands/access_group_test.ts",
  "src/cli/commands/doctor_audit_test.ts",
  "src/cli/context_test.ts",
  "src/cli/commands/model_validate_test.ts",
  "src/cli/commands/worker_verify_test.ts",
  "src/cli/commands/workflow_resume_test.ts",
  "src/cli/commands/workflow_run_test.ts",
  "src/cli/remote_run_test.ts",
  "src/domain/vaults/local_encryption_vault_provider_test.ts",
  "src/domain/workflows/workflow_run_summary_test.ts",
  "src/infrastructure/datastore_v3/litestream/litestream_control_client_test.ts",
  "src/infrastructure/datastore_v3/serve_datastore_client_test.ts",
  "src/infrastructure/datastore_v3/serve_feed_client_test.ts",
  "src/infrastructure/http/extension_api_client_test.ts",
  "src/infrastructure/http/hub_admin_client_test.ts",
  "src/infrastructure/http/swamp_club_client_search_test.ts",
  "src/infrastructure/http/swamp_club_client_inbox_test.ts",
  "src/infrastructure/http/swamp_club_client_test.ts",
  "src/infrastructure/persistence/catalog_store_test.ts",
  "src/infrastructure/persistence/git_worktree_test.ts",
  "src/infrastructure/process/hub_probe_test.ts",
  "src/infrastructure/process/process_executor_test.ts",
  "src/infrastructure/process/process_kill_test.ts",
  "src/infrastructure/process/shutdown_handlers_test.ts",
  "src/infrastructure/process/start_instance_probe_test.ts",
  "src/infrastructure/runtime/embedded_deno_runtime_test.ts",
  "src/infrastructure/runtime/tls_cert_validation_test.ts",
  "src/infrastructure/security/file_security_check_test.ts",
  "src/infrastructure/source/http_source_downloader_test.ts",
  "src/infrastructure/telemetry/http_telemetry_sender_test.ts",
  "src/infrastructure/update/http_update_checker_test.ts",
  "src/infrastructure/update/resumable_download_test.ts",
  "src/libswamp/extensions/push_pull_roundtrip_test.ts",
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
