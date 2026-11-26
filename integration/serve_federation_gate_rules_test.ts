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

import { assert, assertEquals } from "@std/assert";
import { configure, type LogRecord } from "@logtape/logtape";
import { join } from "@std/path";
import {
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";
import { buildCommandTree } from "../src/cli/mod.ts";
import {
  type AnyCommand,
  buildCliSchema,
  type CliCommandSchema,
} from "../src/cli/cli_schema.ts";
import {
  resolveServeRoutes,
  SERVE_ROUTES,
} from "../src/cli/commands/serve_routes.ts";
import { createServeCommand } from "../src/cli/commands/serve_group.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { FEDERATION_GATE_VARIABLE } from "../src/domain/serve/federation_gate.ts";
import {
  loadServeConfig,
  mergeServeOptions,
} from "../src/serve/serve_config.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";

await initializeLogging({});

/**
 * Every surface Serve Federation adds. Each unit appends what it adds; with
 * the gate off none of them may be reachable.
 */
export const FEDERATION_SURFACES = {
  serveSubcommands: ["fingerprint"],
  serveYamlKeys: ["version", "federation"],
} as const;

const GATE_OFF = { [FEDERATION_GATE_VARIABLE]: undefined };
const GATE_ON = { [FEDERATION_GATE_VARIABLE]: "1" };

function serveChildren(node: AnyCommand | undefined): string[] {
  return (node?.getCommands(true) ?? []).map((c: AnyCommand) => c.getName());
}

function schemaCommandPaths(
  node: CliCommandSchema,
  prefix: string[] = [],
): string[] {
  const path = [...prefix, node.name];
  return [
    path.join(" "),
    ...node.subcommands.flatMap((child) => schemaCommandPaths(child, path)),
  ];
}

Deno.test("federation gate: with the gate off, swamp serve resolves no federation subcommand", async () => {
  const routes = resolveServeRoutes(() => undefined);
  assertEquals(routes, SERVE_ROUTES);
  const names = await withMockedEnv(
    GATE_OFF,
    async () => serveChildren(await createServeCommand()),
  );
  for (const surface of FEDERATION_SURFACES.serveSubcommands) {
    assert(!routes.some((route) => route.name === surface), surface);
    assert(!names.includes(surface), surface);
  }
});

Deno.test("federation gate: with the gate off, the help schema has no federation command, hidden or not", async () => {
  const tree = await withMockedEnv(GATE_OFF, () => buildCommandTree());
  for (const includeHidden of [false, true]) {
    const paths = schemaCommandPaths(
      buildCliSchema(tree, VERSION, { includeHidden }).root,
    );
    for (const surface of FEDERATION_SURFACES.serveSubcommands) {
      assert(
        !paths.some((path) => path.endsWith(`serve ${surface}`)),
        `${surface} (includeHidden: ${includeHidden})`,
      );
    }
  }
});

async function loadWithWarnings(
  yaml: string,
): Promise<{ config: Record<string, unknown> | null; warned: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-federation-gate-" });
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [{
      category: ["serve", "config"],
      lowestLevel: "warning",
      sinks: ["capture"],
    }],
    reset: true,
  });
  try {
    await Deno.mkdir(join(dir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(join(dir, ".swamp", "serve.yaml"), yaml);
    const config = withMockedEnv(
      GATE_OFF,
      () => loadServeConfig(undefined, dir),
    ) as Record<string, unknown> | null;
    const warned = captured
      .filter((r) => String(r.rawMessage).includes("Unknown key"))
      .map((r) => String(r.properties.key));
    return { config, warned };
  } finally {
    await initializeLogging({ _reset: true });
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("federation gate: with the gate off, version and federation load as unknown keys and change nothing", async () => {
  const plain = "port: 9191\nschedule: false\n";
  const withSurfaces = "version: 2\nfederation:\n  role: hub\n" + plain;

  const before = await loadWithWarnings(plain);
  const after = await loadWithWarnings(withSurfaces);
  assertEquals(after.warned, [...FEDERATION_SURFACES.serveYamlKeys]);
  assertEquals(before.warned, []);

  const { version: _v, federation: _f, ...rest } = after.config ?? {};
  assertEquals(rest, before.config);

  const merged = withMockedEnv(
    GATE_OFF,
    () => mergeServeOptions(after.config, {}, new Set()),
  );
  assertEquals("federation" in merged, false);
  assertEquals(
    merged,
    withMockedEnv(
      GATE_OFF,
      () => mergeServeOptions(before.config, {}, new Set()),
    ),
  );
});

Deno.test("federation gate: only the gate module names the gate variable", async () => {
  const naming: string[] = [];
  for await (const file of productionSourceFiles(SRC_DIR)) {
    if ((await Deno.readTextFile(file)).includes(FEDERATION_GATE_VARIABLE)) {
      naming.push(repoRelative(file));
    }
  }
  assertEquals(naming, ["src/domain/serve/federation_gate.ts"]);
});

// serve.ts exports one command instance that the group loader registers
// subcommands on, so gate-on trees are built only after every gate-off one
Deno.test("federation gate: with the gate on, swamp serve resolves the federation subcommands", async () => {
  const names = await withMockedEnv(
    GATE_ON,
    async () => serveChildren(await createServeCommand()),
  );
  for (const surface of FEDERATION_SURFACES.serveSubcommands) {
    assert(names.includes(surface), surface);
  }
});

Deno.test("federation gate: with the gate on, the help schema lists the federation commands", async () => {
  const tree = await withMockedEnv(GATE_ON, () => buildCommandTree());
  const paths = schemaCommandPaths(
    buildCliSchema(tree, VERSION).root,
  );
  for (const surface of FEDERATION_SURFACES.serveSubcommands) {
    assert(paths.some((path) => path.endsWith(`serve ${surface}`)), surface);
  }
});
