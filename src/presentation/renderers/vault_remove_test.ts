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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  createVaultRemoveRenderer,
  renderVaultRemoveCancelled,
  renderVaultRemoveWarnings,
} from "./vault_remove.ts";
import type {
  VaultRemoveData,
  VaultRemovePreview,
} from "../../libswamp/vaults/remove.ts";
import { validationFailed } from "../../libswamp/errors.ts";
import { UserError } from "../../domain/errors.ts";

// noColor: true selects LogTape's text formatter, so each record reaches the
// console mocks as one pre-rendered string.
await initializeLogging({ noColor: true });

// LogTape's console sink routes per level (info → console.info, warning →
// console.warn), so capture all of them.
function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  for (const [m] of originals) {
    console[m] = (...args: unknown[]) => {
      lines.push(
        args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
      );
    };
  }
  try {
    fn();
  } finally {
    for (const [m, orig] of originals) {
      console[m] = orig;
    }
  }
  // deno-lint-ignore no-control-regex
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

const directory = "/repo/.swamp/secrets/local_encryption/trip-planner";

function data(overrides: Partial<VaultRemoveData> = {}): VaultRemoveData {
  return {
    vaultName: "trip-planner",
    vaultId: "11111111-1111-4111-8111-111111111111",
    vaultType: "local_encryption",
    forcedReferences: [],
    possibleReferences: [],
    timestamp: "2026-10-19T00:00:00.000Z",
    secrets: { directory, removed: true, secretCount: 2 },
    ...overrides,
  };
}

function preview(
  overrides: Partial<VaultRemovePreview> = {},
): VaultRemovePreview {
  return {
    vaultName: "trip-planner",
    vaultId: "11111111-1111-4111-8111-111111111111",
    vaultType: "local_encryption",
    localStorage: {
      baseDir: "/repo",
      directory,
      secretCount: 2,
      removable: true,
    },
    references: [],
    possibleReferences: [],
    ...overrides,
  };
}

function logCompleted(d: VaultRemoveData): string {
  const handlers = createVaultRemoveRenderer("log").handlers();
  return captureLog(() => handlers.completed!({ kind: "completed", data: d }));
}

Deno.test("createVaultRemoveRenderer: log mode reports the deleted secrets directory", () => {
  const out = logCompleted(data());
  assertStringIncludes(out, "Removed vault");
  assertStringIncludes(out, directory);
  assertStringIncludes(out, "2 secret(s)");
});

Deno.test("createVaultRemoveRenderer: log mode says a provider's secrets were left in place", () => {
  const out = logCompleted(
    data({ vaultType: "@swamp/aws-sm", secrets: undefined }),
  );
  assertStringIncludes(out, "Only the local config was removed");
});

Deno.test("createVaultRemoveRenderer: log mode says secrets outside the repository were kept", () => {
  const out = logCompleted(data({
    secrets: {
      directory,
      removed: false,
      secretCount: 3,
      keptOutsideRepository: true,
    },
  }));
  assertStringIncludes(out, "Kept 3 secret(s)");
  assertStringIncludes(out, "outside this repository");
});

Deno.test("createVaultRemoveRenderer: log mode says when there were no stored secrets", () => {
  const out = logCompleted(
    data({ secrets: { directory, removed: false, secretCount: 0 } }),
  );
  assertStringIncludes(out, "no stored secrets");
});

Deno.test("createVaultRemoveRenderer: log mode warns about forced and possible references", () => {
  const out = logCompleted(data({
    forcedReferences: [{ kind: "definition", name: "app", via: "vault.get" }],
    possibleReferences: [{ kind: "workflow", name: "deploy" }],
  }));
  assertStringIncludes(out, "Still referenced by");
  assertStringIncludes(out, "app");
  assertStringIncludes(out, "deploy");
  assertStringIncludes(out, "computes a vault name at run time");
});

Deno.test("createVaultRemoveRenderer: json mode prints the data", () => {
  const handlers = createVaultRemoveRenderer("json").handlers();
  const out = captureLog(() =>
    handlers.completed!({ kind: "completed", data: data() })
  );
  assertEquals(JSON.parse(out), data());
});

Deno.test("createVaultRemoveRenderer: an error event throws a UserError", () => {
  for (const mode of ["log", "json"] as const) {
    const handlers = createVaultRemoveRenderer(mode).handlers();
    assertThrows(
      () =>
        handlers.error!({ kind: "error", error: validationFailed("refused") }),
      UserError,
      "refused",
    );
  }
});

Deno.test("renderVaultRemoveWarnings: warns that local secrets are deleted for good", () => {
  const out = captureLog(() => renderVaultRemoveWarnings(preview(), "log"));
  assertStringIncludes(out, "permanently deletes");
  assertStringIncludes(out, directory);
  assertStringIncludes(out, "cannot be undone");
});

Deno.test("renderVaultRemoveWarnings: says secrets outside the repository will be kept", () => {
  const out = captureLog(() =>
    renderVaultRemoveWarnings(
      preview({
        localStorage: {
          baseDir: "/elsewhere",
          directory,
          secretCount: 1,
          removable: false,
        },
      }),
      "log",
    )
  );
  assertStringIncludes(out, "will be kept");
});

Deno.test("renderVaultRemoveWarnings: says a provider keeps its secrets, and lists references", () => {
  const out = captureLog(() =>
    renderVaultRemoveWarnings(
      preview({
        vaultType: "@swamp/aws-sm",
        localStorage: undefined,
        references: [{ kind: "workflow", name: "deploy", via: "vaults list" }],
        possibleReferences: [{ kind: "definition", name: "app" }],
      }),
      "log",
    )
  );
  assertStringIncludes(out, "secrets stay with the provider");
  assertStringIncludes(out, "--force removes the vault anyway");
  assertStringIncludes(out, "may use this vault");
});

Deno.test("renderVaultRemoveWarnings: json mode writes nothing", () => {
  const out = captureLog(() => renderVaultRemoveWarnings(preview(), "json"));
  assertEquals(out, "");
});

Deno.test("renderVaultRemoveCancelled: json mode reports cancelled", () => {
  const out = captureLog(() => renderVaultRemoveCancelled("json"));
  assertEquals(JSON.parse(out), { cancelled: true });
});
