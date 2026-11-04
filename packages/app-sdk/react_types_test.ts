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

import { assert } from "@std/assert";
import { useRequest, useSwamp } from "./react.tsx";

// never rendered: these lines are checked by the compiler, not run
function typedRequests(): Promise<void> {
  const query = useRequest("data.query", { predicate: "true" });
  const projected = query.data?.data.projected;
  if (projected?.shape === "scalar") projected.values satisfies unknown[];

  const search = useRequest("workflow.search");
  search.data?.data.results[0]?.name satisfies string | undefined;

  useRequest("workflow.get", { workflowIdOrName: "w" }, { enabled: false });

  // @ts-expect-error a misspelt request does not compile
  useRequest("data.qeury", { predicate: "true" });
  // @ts-expect-error a required payload cannot be left out
  useRequest("data.query");
  // @ts-expect-error a field of the wrong type does not compile
  useRequest("data.query", { predicate: 1 });
  // @ts-expect-error a request no capability allows is not offered
  useRequest("vault.get", {});

  const { request } = useSwamp();
  return request("worker.list").then((reply) => {
    reply.data.workers[0]?.status satisfies
      | "idle"
      | "busy"
      | "disconnected"
      | "unverified"
      | "draining"
      | undefined;
  });
}

Deno.test("useRequest: requests are typed by name", () => {
  assert(typeof typedRequests === "function");
});
