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

// Grant files whose model: selectors spell types non-canonically load
// without error, reconcile into stored grants, and decide as a deny in any
// spelling and an allow only as written (swamp-club#3130): files through the
// shared loader, the reconciler, the policy snapshot loader and the decision
// service, against a real repository.

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { AccessResource } from "../src/domain/access/access_decision_service.ts";
import {
  checkServeGrantFiles,
  readServeGrantFiles,
} from "../src/domain/access/grant_file_loader.ts";
import {
  createFileGrantStore,
  reconcileAllFileGrants,
} from "../src/domain/access/grant_file_reconciler.ts";
import type { GrantFileEntry } from "../src/domain/access/grant_file.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import {
  readConditionTypeLiterals,
  validateGrantCondition,
} from "../src/infrastructure/cel/grant_condition_environment.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-grant-spelling-" });
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
  - subject: "user:dev"
    effect: allow
    actions: [run]
    resource: "model:*"
  - subject: "user:dev"
    effect: deny
    actions: [run]
    resource: "model:@Acme/*"
  - subject: "user:dev"
    effect: deny
    actions: [run]
    resource: "model:AWS::EC2::*"
  - subject: "user:ops"
    effect: allow
    actions: [run]
    resource: "model:@Exp/*"
`;

function modelOfType(modelType: string): AccessResource {
  return {
    kind: "model",
    name: "instance",
    fields: { name: "instance", modelType, tags: {} },
  };
}

Deno.test("grant files with misspelled types: denies match in any spelling, allows only as written", async () => {
  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, "grants"));
    await Deno.writeTextFile(join(repoDir, "grants", "team.yaml"), GRANTS_YAML);

    const files = await readServeGrantFiles(repoDir, {
      validateCondition: validateGrantCondition,
      readTypeLiterals: readConditionTypeLiterals,
    });
    const check = checkServeGrantFiles(files);
    assertEquals(check.errors, []);
    assertEquals(check.warnings.map((w) => w.entry), [2, 3, 4]);

    const repoContext = createRepositoryContext({ repoDir });
    const entries = new Map<string, GrantFileEntry[]>();
    for (const [name, result] of files.repo) entries.set(name, result.entries);
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
      {},
      readConditionTypeLiterals,
    );
    await loader.load();
    const service = loader.decisionService;
    const dev = {
      principal: { kind: "user" as const, id: "dev" },
      collectives: [],
      groups: [],
    };
    const ops = {
      principal: { kind: "user" as const, id: "ops" },
      collectives: [],
      groups: [],
    };

    assertEquals(
      service.decide(dev, "run", modelOfType("@acme/deploy"))?.effect,
      "deny",
    );
    assertEquals(
      service.decide(dev, "run", modelOfType("acme/deploy"))?.effect,
      "deny",
    );
    assertEquals(
      service.decide(dev, "run", modelOfType("aws/ec2/vpc"))?.effect,
      "deny",
    );
    assertEquals(
      service.decide(dev, "run", modelOfType("command/shell"))?.effect,
      "allow",
    );
    assertEquals(service.decide(ops, "run", modelOfType("@exp/probe")), null);
    await loader.dispose();
  });
});
