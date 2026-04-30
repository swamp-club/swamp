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
import { DriverPlan } from "./driver_plan.ts";

Deno.test("DriverPlan.tiers: exposes a readonly view of the constructor tiers", () => {
  const plan = new DriverPlan({
    cli: { driver: "raw" },
    repo: { driver: "docker", driverConfig: { image: "alpine" } },
  });
  assertEquals(plan.tiers.cli?.driver, "raw");
  assertEquals(plan.tiers.repo?.driver, "docker");
  assertEquals(plan.tiers.repo?.driverConfig, { image: "alpine" });
  // Tiers not provided are undefined.
  assertEquals(plan.tiers.step, undefined);
  assertEquals(plan.tiers.job, undefined);
  assertEquals(plan.tiers.workflow, undefined);
});

Deno.test("DriverPlan.withDefinition: cli wins over all lower tiers", () => {
  const plan = new DriverPlan({
    cli: { driver: "raw" },
    step: { driver: "docker" },
    job: { driver: "k8s" },
    workflow: { driver: "ec2" },
    repo: { driver: "lambda" },
  });
  const resolved = plan.withDefinition({ driver: "definition-driver" });
  assertEquals(resolved.driver, "raw");
});

Deno.test("DriverPlan.withDefinition: step wins when cli is unset", () => {
  const plan = new DriverPlan({
    step: { driver: "docker" },
    job: { driver: "k8s" },
    repo: { driver: "lambda" },
  });
  const resolved = plan.withDefinition({ driver: "definition-driver" });
  assertEquals(resolved.driver, "docker");
});

Deno.test("DriverPlan.withDefinition: job wins when cli and step are unset", () => {
  const plan = new DriverPlan({
    job: { driver: "k8s" },
    workflow: { driver: "ec2" },
    repo: { driver: "lambda" },
  });
  const resolved = plan.withDefinition({ driver: "definition-driver" });
  assertEquals(resolved.driver, "k8s");
});

Deno.test("DriverPlan.withDefinition: workflow wins over definition and repo", () => {
  const plan = new DriverPlan({
    workflow: { driver: "ec2" },
    repo: { driver: "lambda" },
  });
  const resolved = plan.withDefinition({ driver: "definition-driver" });
  assertEquals(resolved.driver, "ec2");
});

Deno.test("DriverPlan.withDefinition: definition wins over repo", () => {
  const plan = new DriverPlan({ repo: { driver: "lambda" } });
  const resolved = plan.withDefinition({ driver: "definition-driver" });
  assertEquals(resolved.driver, "definition-driver");
});

Deno.test("DriverPlan.withDefinition: repo wins when no higher tier and no definition", () => {
  const plan = new DriverPlan({ repo: { driver: "lambda" } });
  const resolved = plan.withDefinition({});
  assertEquals(resolved.driver, "lambda");
});

Deno.test("DriverPlan.withDefinition: falls back to 'raw' when nothing is set", () => {
  const plan = new DriverPlan({});
  const resolved = plan.withDefinition({});
  assertEquals(resolved.driver, "raw");
});

Deno.test("DriverPlan.withDefinition: an empty plan still honours the definition tier (post-PR-1253 fix)", () => {
  // Regression for the bug surfaced in #1253: an empty plan must still
  // pass the definition through `resolveDriverConfig`, not hardcode
  // "raw" the way `ctx.driverPlan?.withDefinition(...) ?? { driver: "raw" }`
  // used to.
  const plan = new DriverPlan({});
  const resolved = plan.withDefinition({ driver: "definition-driver" });
  assertEquals(resolved.driver, "definition-driver");
});

Deno.test("DriverPlan.withDefinition: returns the winning tier's driverConfig (no merging)", () => {
  const plan = new DriverPlan({
    cli: { driver: "raw" },
    repo: { driver: "docker", driverConfig: { image: "alpine" } },
  });
  // CLI wins, so its driverConfig (undefined) is returned — repo's
  // image config is NOT merged in.
  const resolved = plan.withDefinition({});
  assertEquals(resolved.driver, "raw");
  assertEquals(resolved.driverConfig, undefined);
});

Deno.test("DriverPlan.withDefinition: definition tier carries its driverConfig when it wins", () => {
  const plan = new DriverPlan({});
  const resolved = plan.withDefinition({
    driver: "docker",
    driverConfig: { image: "ubuntu:22.04" },
  });
  assertEquals(resolved.driver, "docker");
  assertEquals(resolved.driverConfig, { image: "ubuntu:22.04" });
});
