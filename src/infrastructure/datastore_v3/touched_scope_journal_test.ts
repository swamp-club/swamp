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
import { CatalogStore } from "../persistence/catalog_store.ts";
import {
  DEEP_SCOPE_SUFFIX,
  scopeCovers,
  TouchedScopeJournal,
  touchedScopeOf,
  WHOLE_CHECKOUT_SCOPE,
} from "./touched_scope_journal.ts";

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

Deno.test("touchedScopeOf: names a path under the cache root's materialised directories by its record key, and nothing else", () => {
  const root = join("/repo", ".swamp", "cache");
  assertEquals(
    touchedScopeOf(root, join(root, "data", "aws", "ec2", ID, "vpc")),
    `data/aws/ec2/${ID}/vpc`,
  );
  assertEquals(
    touchedScopeOf(root, join(root, "workflow-runs", "wf", "run.yaml")),
    "workflow-runs/wf/run.yaml",
  );
  assertEquals(touchedScopeOf(root, root), undefined);
  assertEquals(touchedScopeOf(root, join("/repo", "elsewhere")), undefined);
  assertEquals(
    touchedScopeOf(root, join(root, "not-projected", "x")),
    undefined,
  );
  assertEquals(
    touchedScopeOf(
      root,
      join(
        root,
        "data",
        "t",
        ID,
        "n",
        ".0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.tmp",
      ),
    ),
    undefined,
  );
});

Deno.test("scopeCovers: a scope covers itself and what is under it, the whole checkout covers everything", () => {
  assertEquals(scopeCovers("data/t/id/n", "data/t/id/n"), true);
  assertEquals(scopeCovers("data/t/id/n", "data/t/id/n/1/raw"), true);
  assertEquals(scopeCovers("data/t/id/n", "data/t/id/n2/1/raw"), false);
  assertEquals(scopeCovers(WHOLE_CHECKOUT_SCOPE, "outputs/x"), true);
  assertEquals(
    scopeCovers(`data/t/id/n${DEEP_SCOPE_SUFFIX}`, "data/t/id/n/1/raw"),
    true,
  );
});

Deno.test("TouchedScopeJournal: records each scope once per unit with its data name, and records nothing before the catalog exists", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-touched-journal-" });
  try {
    const path = join(dir, "_catalog_v3.db");
    const early = new TouchedScopeJournal(path);
    assertEquals(early.record("u1", "", "outputs/x"), false);
    early.close();
    const catalog = new CatalogStore(path);
    catalog.ensureTouchedTracking(1_000);
    const journal = new TouchedScopeJournal(path);
    try {
      assertEquals(journal.record("u1", "", `data/t/${ID}/n`), true);
      assertEquals(journal.record("u1", "", `data/t/${ID}/n`), true);
      assertEquals(journal.record("u1", "", "outputs/x"), true);
      assertEquals(journal.record("u2", "", `data/t/${ID}/n`), true);
      assertEquals(
        journal.recordedFor("u1", "").sort(),
        ["outputs/x", `data/t/${ID}/n`].sort(),
      );
      assertEquals(
        catalog.touchedScopes().map((row) =>
          `${row.unit_id} ${row.scope} ${row.data_name}`
        ),
        [`u1 data/t/${ID}/n n`, "u1 outputs/x ", `u2 data/t/${ID}/n n`],
      );
    } finally {
      journal.close();
      catalog.close();
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
