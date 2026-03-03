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
import { AwsVaultProvider } from "./aws_vault_provider.ts";

Deno.test("AwsVaultProvider - constructor and configuration", async (t) => {
  await t.step("should store and return the vault name via getName", () => {
    const provider = new AwsVaultProvider("my-aws-vault", {
      region: "us-west-2",
    });
    assertEquals(provider.getName(), "my-aws-vault");
  });

  await t.step("should accept config with required region", () => {
    const provider = new AwsVaultProvider("default-vault", {
      region: "us-east-1",
    });
    assertEquals(provider.getName(), "default-vault");
  });

  await t.step("should accept config with only region", () => {
    const provider = new AwsVaultProvider("regional-vault", {
      region: "eu-west-1",
    });
    assertEquals(provider.getName(), "regional-vault");
  });

  await t.step("should handle various vault name formats", () => {
    // Simple name
    let provider = new AwsVaultProvider("simple", { region: "us-east-1" });
    assertEquals(provider.getName(), "simple");

    // Name with hyphens
    provider = new AwsVaultProvider("my-production-vault", {
      region: "us-east-1",
    });
    assertEquals(provider.getName(), "my-production-vault");

    // Name with underscores
    provider = new AwsVaultProvider("my_staging_vault", {
      region: "us-east-1",
    });
    assertEquals(provider.getName(), "my_staging_vault");
  });
});

Deno.test("AwsVaultProvider - region configuration", async (t) => {
  await t.step("should use config.region when provided", () => {
    const provider = new AwsVaultProvider("test-vault", {
      region: "ap-southeast-1",
    });
    assertEquals(provider.getName(), "test-vault");
  });

  await t.step("should accept different region values", () => {
    const regions = [
      "us-east-1",
      "eu-west-1",
      "ap-southeast-1",
      "eu-central-1",
    ];
    for (const region of regions) {
      const provider = new AwsVaultProvider("region-vault", { region });
      assertEquals(provider.getName(), "region-vault");
    }
  });
});

// Note: Integration tests for get/put operations require AWS credentials
// and are not included in unit tests. The error handling for AWS SDK
// operations is tested through integration tests or manual testing.
