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
import { waitFor } from "@swamp-club/swamp-testing";
import { modelRegistry } from "../domain/models/model.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { withExtensionMutation } from "./extension_reload.ts";
import { refreshLocalModelsForRun } from "./local_model_refresh.ts";

await initializeLogging({});

Deno.test("refreshLocalModelsForRun: waits for a hot-reload in progress before checking sources", async () => {
  const order: string[] = [];
  let releaseReload!: () => void;
  modelRegistry.setSourceRefresher(() => {
    order.push("refresh");
    return Promise.resolve();
  });
  try {
    const reload = withExtensionMutation(() => {
      order.push("reload");
      return new Promise<void>((resolve) => releaseReload = resolve);
    });
    await waitFor(() => order.length === 1, "the reload to start");

    const refresh = refreshLocalModelsForRun();
    await Promise.resolve();
    assertEquals(order, ["reload"]);

    releaseReload();
    await Promise.all([reload, refresh]);
    assertEquals(order, ["reload", "refresh"]);
  } finally {
    modelRegistry.setSourceRefresher(null);
  }
});

Deno.test("refreshLocalModelsForRun: a failed check does not fail the run", async () => {
  modelRegistry.setSourceRefresher(() =>
    Promise.reject(new Error("catalog locked"))
  );
  try {
    await refreshLocalModelsForRun();
  } finally {
    modelRegistry.setSourceRefresher(null);
  }
});
