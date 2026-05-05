// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { buildDownloadPlan } from "./download_deno.ts";

// CANARY-BRIDGE: these tests cover the canary opt-in. When the bridge
// ends, delete this file along with the helpers in download_deno.ts.
//
// `scripts/` is excluded from `deno test` in deno.json, so this file
// does not run in CI by default. To run it manually:
//
//   cp scripts/download_deno*.ts /tmp/ \
//     && deno test --no-check --config deno.json /tmp/download_deno_test.ts
//
// The smoke test (compile + run TLS probe against the bundled deno) is
// the load-bearing validation; this file documents the URL-builder
// contract and acts as a fast pre-build sanity check.

Deno.test("buildDownloadPlan: stable channel uses GitHub releases URL", () => {
  const plan = buildDownloadPlan(
    "stable",
    "2.7.14",
    "deno-x86_64-apple-darwin.zip",
  );
  assertEquals(plan.channel, "stable");
  assertEquals(
    plan.url,
    "https://github.com/denoland/deno/releases/download/v2.7.14/deno-x86_64-apple-darwin.zip",
  );
  assertEquals(plan.versionLabel, "2.7.14");
});

Deno.test("buildDownloadPlan: canary channel uses dl.deno.land URL", () => {
  const sha = "19bd3d8b99d92f15d20692aca02ac059bbc9ada7";
  const plan = buildDownloadPlan(
    "canary",
    sha,
    "deno-aarch64-apple-darwin.zip",
  );
  assertEquals(plan.channel, "canary");
  assertEquals(
    plan.url,
    `https://dl.deno.land/canary/${sha}/deno-aarch64-apple-darwin.zip`,
  );
});

Deno.test("buildDownloadPlan: canary versionLabel uses 8-char short sha", () => {
  const plan = buildDownloadPlan(
    "canary",
    "19bd3d8b99d92f15d20692aca02ac059bbc9ada7",
    "deno-x86_64-unknown-linux-gnu.zip",
  );
  assertEquals(plan.versionLabel, "canary-19bd3d8b");
});

Deno.test("buildDownloadPlan: canary label distinct from any stable semver", () => {
  // The runtime compares version markers as exact strings, so canary labels
  // must not collide with semver — guards against stale-cache issues when
  // bridging back to stable.
  const canary = buildDownloadPlan(
    "canary",
    "19bd3d8b99d92f15d20692aca02ac059bbc9ada7",
    "deno-x86_64-apple-darwin.zip",
  );
  const stable = buildDownloadPlan(
    "stable",
    "2.8.0",
    "deno-x86_64-apple-darwin.zip",
  );
  assertEquals(canary.versionLabel === stable.versionLabel, false);
});
