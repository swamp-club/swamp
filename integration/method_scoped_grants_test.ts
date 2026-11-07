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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { vaultKindResource } from "../src/domain/access/access_resources.ts";
import {
  checkServeGrantFiles,
  readServeGrantFiles,
} from "../src/domain/access/grant_file_loader.ts";
import {
  createFileGrantStore,
  reconcileAllFileGrants,
} from "../src/domain/access/grant_file_reconciler.ts";
import type { GrantFileEntry } from "../src/domain/access/grant_file.ts";
import { principalEntries } from "../src/domain/access/grant_file_test_helpers.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import {
  readConditionTypeLiterals,
  validateGrantCondition,
} from "../src/infrastructure/cel/grant_condition_environment.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-method-scoped-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const GRANTS_YAML = `grants:
  - subject: "user:pusher"
    effect: allow
    actions: [read, write]
    resource: "vault:inputs"
    methods: [put]
  - subject: "user:pusher"
    effect: allow
    actions: [run]
    resource: "workflow:*"
    methods: [deploy]
  - subject: "user:runner"
    effect: allow
    actions: [run]
    resource: "model:web"
    methods: [deploy]
`;

const principal = (id: string) => ({
  principal: { kind: "user" as const, id },
  collectives: [],
  groups: [],
  client: undefined,
});

Deno.test("method-scoped grants from a grant file: a vault grant admits only its verbs, and methods a kind never matches warn and admit nothing", async () => {
  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, "grants"));
    await Deno.writeTextFile(join(repoDir, "grants", "team.yaml"), GRANTS_YAML);

    const files = await readServeGrantFiles(repoDir, {
      validateCondition: validateGrantCondition,
      readTypeLiterals: readConditionTypeLiterals,
    });
    const check = checkServeGrantFiles(files);
    assertEquals(check.errors, []);
    assertEquals(check.warnings.map((w) => w.entry), [2]);

    const repoContext = createRepositoryContext({ repoDir });
    const entries = new Map<string, GrantFileEntry[]>();
    for (const [name, result] of files.repo) {
      entries.set(name, principalEntries(result.entries));
    }
    await reconcileAllFileGrants(
      entries,
      createFileGrantStore(
        repoContext.definitionRepo,
        repoContext.definitionRepo,
        repoContext.unifiedDataRepo,
      ),
    );
    const loader = new PolicySnapshotLoader(
      repoContext.unifiedDataRepo,
      repoContext.eventBus,
      "manual",
    );
    await loader.load();
    const service = loader.decisionService;
    const pusher = principal("pusher");
    const vault = (method: "put" | "get" | "describe" | "delete") =>
      vaultKindResource("inputs", "node-14-identity", method);

    assertEquals(
      service.decide(pusher, "write", vault("put"))?.effect,
      "allow",
    );
    assertEquals(service.decide(pusher, "read", vault("get")), null);
    assertEquals(service.decide(pusher, "read", vault("describe")), null);
    assertEquals(service.decide(pusher, "write", vault("delete")), null);
    assertEquals(
      service.decide(pusher, "write", vaultKindResource("inputs")),
      null,
    );
    assertEquals(
      service.decide(pusher, "run", {
        kind: "workflow",
        name: "release",
        fields: { name: "release", tags: {} },
      }),
      null,
    );

    const runner = principal("runner");
    const web = (fields: Record<string, unknown> = {}) => ({
      kind: "model" as const,
      name: "web",
      fields: { name: "web", modelType: "command/shell", tags: {}, ...fields },
    });
    assertEquals(
      service.decide(runner, "run", web({ methodName: "deploy" }))?.effect,
      "allow",
    );
    assertEquals(service.decide(runner, "run", web()), null);
    assertEquals(
      service.decide(runner, "run", web({ methodName: "destroy" })),
      null,
    );
    await loader.dispose();
  });
});
