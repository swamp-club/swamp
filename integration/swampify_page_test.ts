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
import { z } from "zod";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createResourceWriter } from "../src/domain/models/data_writer.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import {
  SWAMPIFY_CANDIDATES_DATA_NAME,
  SWAMPIFY_CANDIDATES_TYPE_TAG,
  SWAMPIFY_COMPARISON_TYPE_TAG,
  SWAMPIFY_OFFER_DATA_NAME,
  SWAMPIFY_OFFER_TYPE_TAG,
  swampifyCandidateSetTags,
  swampifyComparisonDataName,
  swampifyComparisonTags,
  swampifyOfferTags,
} from "../src/domain/agent_sessions/swampify.ts";
import {
  candidateSetListPayload,
  candidateSetProbePayload,
  comparisonListPayload,
  comparisonsByOption,
  itemPayload,
  offerListPayload,
  parseCandidateSetReply,
  parseComparisonReply,
  parseOfferReply,
  parseSwampifyRows,
  shownCandidateSet,
  shownOffer,
  type SwampifyRow,
} from "../packages/dashboard/src/client/swampify.ts";
import { offerView } from "../packages/dashboard/src/lib/swampify_view.ts";
import {
  fixtureCandidateSet,
  fixtureComparison,
  fixtureOffer,
  OPTION_IDS,
} from "../packages/dashboard/src/views/swampify/swampify_fixtures.ts";
import {
  createServeCtx,
  errorFrame,
  grant,
  saveModel,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

function spec(type: string): Record<string, ResourceOutputSpec> {
  return {
    item: {
      schema: z.record(z.string(), z.unknown()),
      lifetime: "infinite",
      garbageCollection: 1,
      tags: { type },
    },
  };
}

async function write(
  repo: ServeRepo,
  owner: Definition,
  type: string,
  name: string,
  body: unknown,
  tags: Record<string, string>,
): Promise<string> {
  const { writeResource } = createResourceWriter(
    repo.repoContext.unifiedDataRepo,
    repo.modelType,
    owner.id,
    spec(type),
    undefined,
    undefined,
    undefined,
    undefined,
    owner.name,
  );
  const handle = await writeResource(
    "item",
    name,
    body as Record<string, unknown>,
    { tags },
  );
  return repo.repoContext.unifiedDataRepo.getContentPath(
    repo.modelType,
    owner.id,
    name,
    handle.version,
  );
}

async function ask(
  ctx: ReturnType<typeof createServeCtx>,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> {
  const frames = await sendRequest(ctx, {
    type,
    id: crypto.randomUUID(),
    payload,
  }) as Array<{ type: string; payload?: { data?: unknown } }>;
  const frame = frames.find((f) => f.type === type);
  return { data: frame?.payload?.data, error: errorFrame(frames) };
}

async function rows(
  ctx: ReturnType<typeof createServeCtx>,
  payload: Record<string, unknown>,
): Promise<readonly SwampifyRow[]> {
  const reply = await ask(ctx, "data.query", payload);
  assertEquals(reply.error, undefined);
  return parseSwampifyRows(reply.data).rows;
}

const NEWER_SET_AT = "2026-11-11T09:00:00.000Z";

async function withSwampify(
  fn: (repo: ServeRepo, bodies: readonly string[]) => Promise<void>,
): Promise<void> {
  await withServeRepo(async (repo) => {
    const swampify = await saveModel(repo, "swampify");
    const elsewhere = await saveModel(repo, "elsewhere");
    // private holds the newer offer and a comparison READ_SHOWN cannot read
    const hidden = await saveModel(repo, "private");
    const set = fixtureCandidateSet();
    const newerSet = fixtureCandidateSet({ generatedAt: NEWER_SET_AT });
    const offer = fixtureOffer("built");
    const hiddenOffer = {
      ...fixtureOffer("declined"),
      updatedAt: "2026-11-12T09:00:00.000Z",
    };
    const shown = fixtureComparison();
    const hiddenComparison = fixtureComparison({
      optionId: OPTION_IDS[1],
      candidateIds: [offer.options[1].candidateIds[0]],
    });
    const bodies = [
      await write(
        repo,
        swampify,
        SWAMPIFY_CANDIDATES_TYPE_TAG,
        SWAMPIFY_CANDIDATES_DATA_NAME,
        set,
        swampifyCandidateSetTags(set),
      ),
      await write(
        repo,
        elsewhere,
        SWAMPIFY_CANDIDATES_TYPE_TAG,
        SWAMPIFY_CANDIDATES_DATA_NAME,
        newerSet,
        swampifyCandidateSetTags(newerSet),
      ),
      await write(
        repo,
        swampify,
        SWAMPIFY_OFFER_TYPE_TAG,
        SWAMPIFY_OFFER_DATA_NAME,
        offer,
        swampifyOfferTags(offer),
      ),
      await write(
        repo,
        hidden,
        SWAMPIFY_OFFER_TYPE_TAG,
        SWAMPIFY_OFFER_DATA_NAME,
        hiddenOffer,
        swampifyOfferTags(hiddenOffer),
      ),
      await write(
        repo,
        swampify,
        SWAMPIFY_COMPARISON_TYPE_TAG,
        swampifyComparisonDataName(shown.optionId),
        shown,
        swampifyComparisonTags(shown),
      ),
      await write(
        repo,
        hidden,
        SWAMPIFY_COMPARISON_TYPE_TAG,
        swampifyComparisonDataName(hiddenComparison.optionId),
        hiddenComparison,
        swampifyComparisonTags(hiddenComparison),
      ),
    ];
    await fn(repo, bodies);
  });
}

const READ_SHOWN = [
  grant({ actions: ["read"], resource: { kind: "data", pattern: "swampify" } }),
  grant({
    actions: ["read"],
    resource: { kind: "data", pattern: "elsewhere" },
  }),
];
const READ_ALL = [
  grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
];

Deno.test("swampify page: the sidebar probe finds the candidate set a viewer may read", async () => {
  await withSwampify(async (repo) => {
    const ctx = createServeCtx(repo, READ_SHOWN);
    assertEquals((await rows(ctx, candidateSetProbePayload())).length, 1);
  });
});

Deno.test("swampify page: the reader shows the newest set across behaviors, the offer it may read, and only readable comparisons", async () => {
  await withSwampify(async (repo) => {
    const ctx = createServeCtx(repo, READ_SHOWN);

    const setRows = await rows(ctx, candidateSetListPayload());
    assertEquals(setRows.map((r) => r.modelName).sort(), [
      "elsewhere",
      "swampify",
    ]);
    const setRow = shownCandidateSet(setRows)!;
    assertEquals(setRow.modelName, "elsewhere");
    const set = parseCandidateSetReply(
      (await ask(ctx, "data.get", itemPayload(setRow))).data,
    );
    assertEquals(set.kind === "record" && set.record.generatedAt, NEWER_SET_AT);

    // the private behavior's newer offer is dropped before the rule runs
    const offerRows = await rows(ctx, offerListPayload());
    assertEquals(offerRows.map((r) => r.modelName), ["swampify"]);
    const offer = parseOfferReply(
      (await ask(ctx, "data.get", itemPayload(shownOffer(offerRows)!))).data,
    );
    assert(offer.kind === "record" && set.kind === "record");
    const view = offerView(offer.record, set.record, setRow.tags.generatedAt);
    assertEquals(view.earlier, true);

    const byOption = comparisonsByOption(
      await rows(ctx, comparisonListPayload()),
    );
    assertEquals([...byOption.keys()], [OPTION_IDS[0]]);
    const comparison = parseComparisonReply(
      (await ask(ctx, "data.get", itemPayload(byOption.get(OPTION_IDS[0])!)))
        .data,
    );
    assertEquals(
      comparison.kind === "record" && comparison.record.optionId,
      OPTION_IDS[0],
    );

    const direct = await ask(ctx, "data.get", {
      modelIdOrName: "private",
      dataName: swampifyComparisonDataName(OPTION_IDS[1]),
      includeContent: true,
    });
    assert(direct.error, "a direct read of the private comparison is refused");
  });
});

Deno.test("swampify page: a viewer who may read everything sees the newer offer and both comparisons", async () => {
  await withSwampify(async (repo) => {
    const ctx = createServeCtx(repo, READ_ALL);
    assertEquals(
      shownOffer(await rows(ctx, offerListPayload()))?.modelName,
      "private",
    );
    assertEquals(
      [...comparisonsByOption(await rows(ctx, comparisonListPayload())).keys()]
        .sort(),
      [...OPTION_IDS].sort(),
    );
  });
});

Deno.test("swampify page: a viewer without read gets nothing, even by a direct read", async () => {
  await withSwampify(async (repo) => {
    const stranger = createServeCtx(repo, []);
    for (
      const payload of [
        candidateSetProbePayload(),
        candidateSetListPayload(),
        offerListPayload(),
        comparisonListPayload(),
      ]
    ) {
      const reply = await ask(stranger, "data.query", payload);
      assertEquals(parseSwampifyRows(reply.data).rows.length, 0);
    }
    const direct = await ask(stranger, "data.get", {
      modelIdOrName: "swampify",
      dataName: SWAMPIFY_CANDIDATES_DATA_NAME,
      includeContent: true,
    });
    assert(direct.error, "a direct read is refused");
  });
});

Deno.test("swampify page: the probe and every list read tags only, never a body", async () => {
  await withSwampify(async (repo, bodies) => {
    for (const body of bodies) {
      await Deno.remove(body);
      await Deno.mkdir(body);
    }
    const ctx = createServeCtx(repo, READ_ALL);
    assertEquals((await rows(ctx, candidateSetProbePayload())).length, 1);
    assertEquals((await rows(ctx, candidateSetListPayload())).length, 2);
    assertEquals((await rows(ctx, offerListPayload())).length, 2);
    assertEquals((await rows(ctx, comparisonListPayload())).length, 2);
  });
});
