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
import type { ReportedIntegration } from "../domain/access/integration_directory.ts";
import {
  beatOnIntegrationChange,
  type IntegrationReportSource,
  withReportedIntegrations,
} from "./club_integration_report.ts";

function source(reported: readonly ReportedIntegration[] | undefined) {
  const listeners = new Set<() => void>();
  const value: IntegrationReportSource & { change(): void } = {
    reported: () => reported,
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    change: () => listeners.forEach((listener) => listener()),
  };
  return value;
}

Deno.test("withReportedIntegrations: adds the list once known, and leaves the field out before", () => {
  const list: ReportedIntegration[] = [
    { id: "acme-slack", state: "active", createdAt: "2026-11-01T00:00:00Z" },
  ];
  assertEquals(withReportedIntegrations({ instanceId: "i" }, source(list)), {
    instanceId: "i",
    integrations: list,
  });
  assertEquals(withReportedIntegrations({ instanceId: "i" }, source([])), {
    instanceId: "i",
    integrations: [],
  });
  assertEquals(
    "integrations" in
      withReportedIntegrations({ instanceId: "i" }, source(undefined)),
    false,
  );
});

Deno.test("beatOnIntegrationChange: beats the heartbeat service current at the time of the change", () => {
  const changes = source([]);
  const beats: string[] = [];
  let current: { beatNow(): void } | null = null;
  beatOnIntegrationChange(changes, () => current);

  changes.change();
  current = { beatNow: () => beats.push("first") };
  changes.change();
  current = { beatNow: () => beats.push("second") };
  changes.change();

  assertEquals(beats, ["first", "second"]);
});
