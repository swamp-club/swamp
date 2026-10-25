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
import { ModelType } from "../models/model_type.ts";
import { createIntent, type Intent, INTENT_KINDS, modelRef } from "./intent.ts";
import {
  bindKey,
  type IntentOpKind,
  LOCKFILE_RECORD_KEY,
  opKindAllowed,
} from "./intent_key_paths.ts";
import { RecordKey } from "./record_key.ts";
import { sampleIntent } from "./v3_test_helpers.ts";

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const RUN = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const WORKFLOW = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const TYPE = ModelType.create("@swamp/aws-ec2");
const MODEL = modelRef(TYPE, ID);
const DATA = `data/@swamp/aws-ec2/${ID}`;

function intent(value: Record<string, unknown>): Intent {
  return createIntent(value);
}

function bound(
  i: Intent,
  key: string,
  opKind: IntentOpKind = "put",
): boolean {
  return bindKey(i, opKind, RecordKey.create(key)).ok;
}

Deno.test("bindKey: a data save owns its version's files and the name's latest marker", () => {
  const save = intent({
    kind: "data.save",
    model: MODEL,
    name: "vpc",
    version: 3,
  });
  assert(bound(save, `${DATA}/vpc/3/raw`));
  assert(bound(save, `${DATA}/vpc/3/metadata.yaml`));
  assert(bound(save, `${DATA}/vpc/latest`));
  assert(!bound(save, `${DATA}/vpc/4/raw`), "another version");
  assert(!bound(save, `${DATA}/subnet/3/raw`), "another name");
  assert(!bound(save, `${DATA}/vpc/3/other`), "another file");
  assert(
    !bound(save, `data/@swamp/aws-ec2/${OTHER_ID}/vpc/3/raw`),
    "another behavior",
  );
  assert(!bound(save, `data/@swamp/aws-s3/${ID}/vpc/3/raw`), "another type");
  assert(!bound(save, `outputs/@swamp/aws-ec2/create/x.yaml`));
});

Deno.test("bindKey: a versioned removal owns only its version's files, a version-less one only the marker", () => {
  const versioned = intent({
    kind: "data.delete",
    model: MODEL,
    name: "vpc",
    version: 2,
  });
  assert(bound(versioned, `${DATA}/vpc/2/raw`, "tombstone"));
  assert(!bound(versioned, `${DATA}/vpc/latest`, "put"));
  const marker = intent({ kind: "data.gc", model: MODEL, name: "vpc" });
  assert(bound(marker, `${DATA}/vpc/latest`, "put"));
  assert(bound(marker, `${DATA}/vpc/latest`, "tombstone"));
  assert(!bound(marker, `${DATA}/vpc/2/raw`, "tombstone"));
});

Deno.test("bindKey: a data rename owns both names' keys", () => {
  const rename = intent({
    kind: "data.rename",
    model: MODEL,
    name: "a",
    to: "b",
  });
  assert(bound(rename, `${DATA}/a/1/metadata.yaml`));
  assert(bound(rename, `${DATA}/b/7/raw`));
  assert(!bound(rename, `${DATA}/c/1/raw`));
});

Deno.test("bindKey: an output names its type across segments, and no other type", () => {
  const output = intent({ kind: "output.save", model: MODEL, outputId: "o" });
  assert(bound(output, "outputs/@swamp/aws-ec2/create/o-1.yaml"));
  assert(!bound(output, "outputs/@swamp/aws-s3/create/o-1.yaml"));
  assert(!bound(output, "outputs/@swamp/create/o-1.yaml"));
  assert(!bound(output, `${DATA}/vpc/latest`));
});

Deno.test("bindKey: runs and run snapshots own only their own record", () => {
  const run = intent({
    kind: "run.update",
    run: { workflowId: WORKFLOW, runId: RUN },
  });
  assert(bound(run, `workflow-runs/${WORKFLOW}/workflow-run-${RUN}.yaml`));
  assert(!bound(run, `workflow-runs/${WORKFLOW}/workflow-run-${ID}.yaml`));
  const snapshot = intent({
    kind: "run-snapshot.save",
    run: { workflowId: WORKFLOW, runId: RUN },
  });
  assert(
    bound(snapshot, `workflows-evaluated/runs/${RUN}/evaluated-workflow.yaml`),
  );
  assert(
    !bound(snapshot, `workflows-evaluated/runs/${ID}/evaluated-workflow.yaml`),
  );
});

Deno.test("bindKey: a behavior definition's key names its type, and a uuid file is returned for an owner check", () => {
  const create = intent({
    kind: "definition.create",
    definition: { kind: "model", name: "web" },
  });
  const byName = bindKey(
    create,
    "put",
    RecordKey.create("config/models/@swamp/aws-ec2/web.yaml"),
  );
  assert(byName.ok);
  assertEquals(byName.type?.normalized, "@swamp/aws-ec2");
  const byId = bindKey(
    create,
    "put",
    RecordKey.create(`config/models/aws/ec2/${ID}.yaml`),
  );
  assert(byId.ok);
  assertEquals(byId.fileId, ID);
  assert(!bound(create, "config/models/@swamp/aws-ec2/other.yaml"));
  assert(!bound(create, "config/workflows/workflow-web.yaml"));
  const untyped = bindKey(
    create,
    "put",
    RecordKey.create("config/models/web.yaml"),
  );
  assert(!untyped.ok);
});

Deno.test("bindKey: workflow and vault definitions, and renames, follow their layouts", () => {
  const workflow = intent({
    kind: "definition.edit",
    definition: { kind: "workflow", name: "deploy" },
  });
  assert(bound(workflow, "config/workflows/workflow-deploy.yaml"));
  assert(!bound(workflow, "config/workflows/workflow-other.yaml"));
  const vault = intent({
    kind: "definition.create",
    definition: { kind: "vault", name: "prod" },
  });
  assert(bound(vault, `config/vaults/local_encryption/${ID}.yaml`));
  assert(!bound(vault, "config/vaults/local_encryption/prod.yaml"));
  const renameTo = intent({
    kind: "definition.rename-to",
    definition: { kind: "workflow", name: "new" },
    from: "old",
  });
  assert(bound(renameTo, "config/workflows/workflow-new.yaml"));
  assert(!bound(renameTo, "config/workflows/workflow-new.yaml", "tombstone"));
  const evaluated = intent({
    kind: "evaluated-workflow.save",
    definition: { kind: "workflow", name: "deploy" },
  });
  assert(bound(evaluated, "workflows-evaluated/workflow-deploy.yaml"));
  assert(
    !bound(evaluated, "workflows-evaluated/runs/x/evaluated-workflow.yaml"),
  );
});

Deno.test("bindKey: an auto-definition or evaluated definition hands back a name it cannot check", () => {
  const auto = intent({
    kind: "auto-definition.save",
    autoDefinition: { id: ID },
  });
  const named = bindKey(
    auto,
    "put",
    RecordKey.create("auto-definitions/@swamp/aws-ec2/web.yaml"),
  );
  assert(named.ok);
  assertEquals(named.fileName, "web");
  assert(bound(auto, `auto-definitions/@swamp/aws-ec2/${ID}.yaml`));
  assert(
    !bound(auto, `auto-definitions/@swamp/aws-ec2/${OTHER_ID}.yaml`),
    "another auto-definition's id",
  );
  const evaluated = intent({
    kind: "evaluated-definition.save",
    model: MODEL,
  });
  assert(bound(evaluated, `definitions-evaluated/@swamp/aws-ec2/${ID}.yaml`));
  assert(!bound(evaluated, `definitions-evaluated/@swamp/aws-s3/${ID}.yaml`));
});

Deno.test("bindKey: the lockfile owns exactly its key", () => {
  const lockfile = intent({ kind: "lockfile.write" });
  assert(bound(lockfile, LOCKFILE_RECORD_KEY));
  assert(!bound(lockfile, "config/other.json"));
  assert(!bound(lockfile, LOCKFILE_RECORD_KEY, "tombstone"));
});

Deno.test("opKindAllowed: every intent kind may ride at least one op kind", () => {
  for (const kind of INTENT_KINDS) {
    const fixture = sampleIntent(kind);
    assert(
      opKindAllowed(fixture, "put") || opKindAllowed(fixture, "tombstone"),
      kind,
    );
  }
});

Deno.test("opKindAllowed: removals never ride a put and saves never a tombstone", () => {
  assert(!opKindAllowed(sampleIntent("output.delete"), "put"));
  assert(!opKindAllowed(sampleIntent("run.delete"), "put"));
  assert(!opKindAllowed(sampleIntent("data.save"), "tombstone"));
  assert(!opKindAllowed(sampleIntent("run.create"), "tombstone"));
  assert(opKindAllowed(sampleIntent("grant.revoke"), "put"));
});
