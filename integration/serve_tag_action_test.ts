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

/**
 * A tag condition on a `data:` grant scopes reads only while the reader
 * cannot retag what owns the data (swamp-club#3085). These tests drive
 * `model.edit`, `workflow.edit` and the data reads through serve's real
 * dispatch over a real repository: with `tag-requires-explicit-grant` a
 * `write` grant no longer carries a retag, so a member cannot pull another
 * team's model or workflow into their tag and read its data.
 */

import { assertEquals } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import type { Definition } from "../src/domain/definitions/definition.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import type { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveData,
  saveModel,
  saveRunWithData,
  saveWorkflow,
  saveWorkflowData,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

/**
 * The issue's setup: read, write and run on every model and workflow, and
 * read on data only where its owner is tagged team-a.
 */
function teamAReaderGrants(): Grant[] {
  return [
    grant({ actions: ["read", "write", "run"] }),
    grant({
      actions: ["read", "write", "run"],
      resource: { kind: "workflow", pattern: "*" },
    }),
    grant({
      actions: ["read"],
      resource: { kind: "data", pattern: "*" },
      condition: 'tags.team == "team-a"',
    }),
  ];
}

function retagModel(
  ctx: ReturnType<typeof createServeCtx>,
  model: Definition,
  tags: Record<string, string>,
): Promise<Frame[]> {
  return sendRequest(ctx, {
    type: "model.edit",
    id: crypto.randomUUID(),
    payload: {
      modelIdOrName: model.name,
      content: stringifyYaml({
        ...JSON.parse(JSON.stringify(model.toData())),
        tags,
      }),
    },
  });
}

function retagWorkflow(
  ctx: ReturnType<typeof createServeCtx>,
  workflow: Workflow,
  tags: Record<string, string>,
): Promise<Frame[]> {
  return sendRequest(ctx, {
    type: "workflow.edit",
    id: crypto.randomUUID(),
    payload: {
      workflowIdOrName: workflow.name,
      content: stringifyYaml({
        ...JSON.parse(JSON.stringify(workflow.toData())),
        tags,
      }),
    },
  });
}

function listModelData(
  ctx: ReturnType<typeof createServeCtx>,
  model: Definition,
): Promise<Frame[]> {
  return sendRequest(ctx, {
    type: "data.list",
    id: crypto.randomUUID(),
    payload: { modelIdOrName: model.name },
  });
}

function getWorkflowData(
  ctx: ReturnType<typeof createServeCtx>,
  workflow: Workflow,
): Promise<Frame[]> {
  return sendRequest(ctx, {
    type: "data.get",
    id: crypto.randomUUID(),
    payload: { workflowName: workflow.name, dataName: "summary" },
  });
}

async function storedModelTags(
  repo: ServeRepo,
  name: string,
): Promise<Record<string, string> | undefined> {
  return (await repo.repoContext.definitionRepo.findByNameGlobal(name))
    ?.definition.tags;
}

async function otherTeamModel(repo: ServeRepo): Promise<Definition> {
  const model = await saveModel(repo, "other-model", { team: "team-b" });
  await saveData(repo, model, "state");
  return model;
}

Deno.test("serve tag action: with tag-requires-explicit-grant, a write grant cannot retag another team's model into a tag a data grant reads", async () => {
  await withServeRepo(async (repo) => {
    const model = await otherTeamModel(repo);
    const ctx = createServeCtx(repo, teamAReaderGrants(), {
      tagRequiresExplicitGrant: true,
    });
    assertEquals(
      errorFrame(await listModelData(ctx, model)) !== undefined,
      true,
    );

    const edit = await retagModel(ctx, model, { team: "team-a" });

    assertEquals(errorFrame(edit)?.error?.code, "unauthorized");
    assertEquals(await storedModelTags(repo, "other-model"), {
      team: "team-b",
    });
    assertEquals(
      errorFrame(await listModelData(ctx, model)) !== undefined,
      true,
    );
  });
});

Deno.test("serve tag action: by default a write grant still carries a retag, as before", async () => {
  await withServeRepo(async (repo) => {
    const model = await otherTeamModel(repo);
    const ctx = createServeCtx(repo, teamAReaderGrants());

    const edit = await retagModel(ctx, model, { team: "team-a" });

    assertEquals(errorFrame(edit), undefined);
    assertEquals(await storedModelTags(repo, "other-model"), {
      team: "team-a",
    });
    assertEquals(errorFrame(await listModelData(ctx, model)), undefined);
  });
});

Deno.test("serve tag action: without the setting, a deny on tag closes the retag", async () => {
  await withServeRepo(async (repo) => {
    const model = await otherTeamModel(repo);
    const ctx = createServeCtx(repo, [
      ...teamAReaderGrants(),
      grant({ effect: "deny", actions: ["tag"] }),
    ]);

    const edit = await retagModel(ctx, model, { team: "team-a" });

    assertEquals(errorFrame(edit)?.error?.code, "unauthorized");
    assertEquals(await storedModelTags(repo, "other-model"), {
      team: "team-b",
    });
    // Edits that leave the tags alone still pass on write.
    const untouched = await retagModel(ctx, model, { team: "team-b" });
    assertEquals(errorFrame(untouched), undefined);
  });
});

Deno.test("serve tag action: a self-service tag grant lets a member claim an untagged model but not another team's", async () => {
  await withServeRepo(async (repo) => {
    const other = await otherTeamModel(repo);
    const fresh = await saveModel(repo, "fresh-model");
    const ctx = createServeCtx(repo, [
      ...teamAReaderGrants(),
      grant({
        actions: ["tag"],
        condition: '!("team" in tags) || tags.team == "team-a"',
      }),
    ], { tagRequiresExplicitGrant: true });

    const claim = await retagModel(ctx, fresh, { team: "team-a" });
    assertEquals(errorFrame(claim), undefined);
    assertEquals(await storedModelTags(repo, "fresh-model"), {
      team: "team-a",
    });

    const steal = await retagModel(ctx, other, { team: "team-a" });
    assertEquals(errorFrame(steal)?.error?.code, "unauthorized");
    assertEquals(await storedModelTags(repo, "other-model"), {
      team: "team-b",
    });
  });
});

Deno.test("serve tag action: a name-scoped tag grant cannot be reached by renaming another team's model first, then retagging it", async () => {
  await withServeRepo(async (repo) => {
    const model = await otherTeamModel(repo);
    const ctx = createServeCtx(repo, [
      ...teamAReaderGrants(),
      grant({
        actions: ["tag"],
        resource: { kind: "model", pattern: "team-a-*" },
      }),
    ], { tagRequiresExplicitGrant: true });

    const rename = await sendRequest(ctx, {
      type: "model.edit",
      id: crypto.randomUUID(),
      payload: {
        modelIdOrName: model.name,
        content: stringifyYaml({
          ...JSON.parse(JSON.stringify(model.toData())),
          name: "team-a-loot",
        }),
        allowRename: true,
      },
    });

    assertEquals(errorFrame(rename)?.error?.code, "unauthorized");
    assertEquals(
      await repo.repoContext.definitionRepo.findByNameGlobal("team-a-loot"),
      null,
    );
    assertEquals(await storedModelTags(repo, "other-model"), {
      team: "team-b",
    });
  });
});

Deno.test("serve tag action: with tag-requires-explicit-grant, a workflow retag is refused and its data stays unreadable", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "step-model");
    const workflow = await saveWorkflow(repo, "other-wf", model, {
      team: "team-b",
    });
    // Workflow-scope data is read through the run that recorded it.
    const summary = await saveWorkflowData(repo, workflow, "summary");
    await saveRunWithData(repo, workflow, [], [summary]);
    const strict = createServeCtx(repo, teamAReaderGrants(), {
      tagRequiresExplicitGrant: true,
    });
    assertEquals(
      errorFrame(await getWorkflowData(strict, workflow)) !== undefined,
      true,
    );

    const refused = await retagWorkflow(strict, workflow, { team: "team-a" });

    assertEquals(errorFrame(refused)?.error?.code, "unauthorized");
    assertEquals(
      (await repo.repoContext.workflowRepo.findByName("other-wf"))?.tags,
      { team: "team-b" },
    );
    assertEquals(
      errorFrame(await getWorkflowData(strict, workflow)) !== undefined,
      true,
    );

    // The same retag passes on write by default, and the data then reads.
    const lenient = createServeCtx(repo, teamAReaderGrants());
    assertEquals(
      errorFrame(await retagWorkflow(lenient, workflow, { team: "team-a" })),
      undefined,
    );
    assertEquals(
      errorFrame(await getWorkflowData(lenient, workflow)),
      undefined,
    );
  });
});
