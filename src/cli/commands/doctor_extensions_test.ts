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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { registerManagedConfig } from "../../infrastructure/persistence/paths.ts";
import type { RepoMarkerData } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { rescanSkippedFor } from "./doctor_extensions.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("doctorExtensionsCommand module loads", async () => {
  const mod = await import("./doctor_extensions.ts");
  assertEquals(typeof mod.doctorExtensionsCommand, "object");
});

Deno.test("doctorExtensionsCommand is registered as subcommand of doctorCommand", async () => {
  const { doctorCommand } = await import("./doctor.ts");
  const commands = doctorCommand.getCommands();
  const extCmd = commands.find((c) => c.getName() === "extensions");
  assertEquals(extCmd !== undefined, true);
});

// ── rescanSkippedFor (swamp-club#2483) ──────────────────────────────────────

const unsetDatastoreEnv = () => undefined;

function managedMarker(type: string): RepoMarkerData {
  return {
    swampVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    datastore: { type, managedConfig: true },
  };
}

Deno.test("rescanSkippedFor: skips the rescan and repairs while the managed config base is unresolved", () => {
  const repo = resolve(`/repo-doctor-${crypto.randomUUID()}`);
  const marker = managedMarker(`@t${crypto.randomUUID().slice(0, 8)}/ds`);

  const withRepair = rescanSkippedFor(repo, marker, true, unsetDatastoreEnv);
  assertEquals(withRepair?.repairSkipped, true);
  assertStringIncludes(withRepair?.reason ?? "", "swamp datastore sync --pull");

  const withoutRepair = rescanSkippedFor(
    repo,
    marker,
    false,
    unsetDatastoreEnv,
  );
  assertEquals(withoutRepair?.repairSkipped, false);
});

Deno.test("rescanSkippedFor: runs the rescan once the managed config base is resolved", () => {
  const repo = resolve(`/repo-doctor-${crypto.randomUUID()}`);
  const marker = managedMarker(`@t${crypto.randomUUID().slice(0, 8)}/ds`);
  registerManagedConfig(repo, true, join(repo, "cache", "config"));

  assertEquals(
    rescanSkippedFor(repo, marker, true, unsetDatastoreEnv),
    undefined,
  );
});

Deno.test("rescanSkippedFor: never skips on a filesystem datastore", () => {
  const repo = resolve(`/repo-doctor-${crypto.randomUUID()}`);

  assertEquals(
    rescanSkippedFor(
      repo,
      managedMarker("filesystem"),
      true,
      unsetDatastoreEnv,
    ),
    undefined,
  );
});
