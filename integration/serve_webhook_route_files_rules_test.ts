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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  assertPinnedSet,
  collectImportEdges,
  extractImports,
  productionSourceFiles,
  repoRelative,
  resolveImport,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const LOADER = "src/serve/webhook_route_files.ts";

// a pulled or local extension must never open an endpoint, so nothing that
// locates or loads extension code may reach the route-file loader or its updater
const EXTENSION_LOCATION_MODULES = [
  "src/cli/resolve_webhooks_dir.ts",
  "src/cli/resolve_extension_files.ts",
  "src/infrastructure/persistence/swamp_sources_repository.ts",
  "src/libswamp/extensions/pull.ts",
  "src/libswamp/extensions/push.ts",
];

const ROUTE_TABLE_MODULES = [
  LOADER,
  "src/serve/webhook_reload.ts",
];

Deno.test("webhook route files: the loader imports only the modules pinned here", async () => {
  const path = join(SRC_DIR, "serve", "webhook_route_files.ts");
  const imports = extractImports(await Deno.readTextFile(path))
    .map((specifier) => resolveImport(path, specifier) ?? specifier)
    .sort();

  for (const forbidden of EXTENSION_LOCATION_MODULES) {
    assertEquals(
      imports.includes(forbidden),
      false,
      `${LOADER} imports ${forbidden}`,
    );
  }
  assertPinnedSet(
    imports,
    [
      "@std/path",
      "@std/yaml",
      "src/domain/errors.ts",
      "src/serve/serve_config.ts",
      "src/serve/webhook.ts",
      "src/serve/webhook_route.ts",
    ],
    "webhook route file loader imports",
    "The loader reads one reviewed directory. Do not give it a path to extension " +
      "code; if a new import is genuinely needed, pin it here after review.",
  );
});

Deno.test("webhook route files: only pinned modules import the loader or the route-table updater", async () => {
  const edges = await collectImportEdges(SRC_DIR, (file, specifier) => {
    const target = resolveImport(file, specifier);
    return target !== undefined && ROUTE_TABLE_MODULES.includes(target);
  });

  assertPinnedSet(
    edges,
    [
      "src/cli/commands/serve.ts -> src/serve/webhook_reload.ts",
      "src/cli/commands/serve.ts -> src/serve/webhook_route_files.ts",
      "src/serve/extension_reload.ts -> src/serve/webhook_reload.ts",
      "src/serve/webhook_reload.ts -> src/serve/webhook_route_files.ts",
    ],
    "importers of the webhook route table",
    "Routes come only from serve.yaml, --webhook flags and the webhook routes " +
      "directory. An extension loading path must never build or update the " +
      "route table.",
  );
});

Deno.test("webhook route files: routes are registered only from pinned call sites", async () => {
  const sites: string[] = [];
  for await (const file of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(file);
    if (/\bnew WebhookService\(/.test(source)) {
      sites.push(`${repoRelative(file)}: new WebhookService`);
    }
    if (/\.updateEndpoints\(/.test(source)) {
      sites.push(`${repoRelative(file)}: updateEndpoints`);
    }
  }

  assertPinnedSet(
    sites,
    [
      "src/cli/commands/serve.ts: new WebhookService",
      "src/serve/webhook_reload.ts: updateEndpoints",
    ],
    "webhook route registration sites",
    "Serve builds its routes once at startup and changes them only through the " +
      "reload updater. Route a new source through buildWebhookRouteTable instead.",
  );
});
