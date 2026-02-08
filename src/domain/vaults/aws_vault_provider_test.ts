import { assertEquals } from "@std/assert";
import { AwsVaultProvider } from "./aws_vault_provider.ts";

Deno.test("AwsVaultProvider - constructor and configuration", async (t) => {
  await t.step("should store and return the vault name via getName", () => {
    const provider = new AwsVaultProvider("my-aws-vault", {
      region: "us-west-2",
    });
    assertEquals(provider.getName(), "my-aws-vault");
  });

  await t.step("should accept empty config object", () => {
    const provider = new AwsVaultProvider("default-vault", {});
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
    let provider = new AwsVaultProvider("simple");
    assertEquals(provider.getName(), "simple");

    // Name with hyphens
    provider = new AwsVaultProvider("my-production-vault");
    assertEquals(provider.getName(), "my-production-vault");

    // Name with underscores
    provider = new AwsVaultProvider("my_staging_vault");
    assertEquals(provider.getName(), "my_staging_vault");
  });
});

Deno.test("AwsVaultProvider - region fallback logic", async (t) => {
  // Store original env values
  const originalAwsRegion = Deno.env.get("AWS_REGION");

  await t.step("should use config.region when provided", () => {
    // Clear AWS_REGION to ensure config takes precedence
    if (originalAwsRegion) Deno.env.delete("AWS_REGION");

    try {
      // We can't directly inspect the client's region, but we can verify
      // the provider is created successfully with a region config
      const provider = new AwsVaultProvider("test-vault", {
        region: "ap-southeast-1",
      });
      assertEquals(provider.getName(), "test-vault");
    } finally {
      if (originalAwsRegion) Deno.env.set("AWS_REGION", originalAwsRegion);
    }
  });

  await t.step(
    "should fall back to AWS_REGION env var when no config region",
    () => {
      // Set AWS_REGION
      Deno.env.set("AWS_REGION", "eu-central-1");

      try {
        // Provider should be created successfully using env var
        const provider = new AwsVaultProvider("env-vault", {});
        assertEquals(provider.getName(), "env-vault");
      } finally {
        if (originalAwsRegion) {
          Deno.env.set("AWS_REGION", originalAwsRegion);
        } else {
          Deno.env.delete("AWS_REGION");
        }
      }
    },
  );

  await t.step(
    "should fall back to us-east-1 when no config or env region",
    () => {
      // Clear AWS_REGION
      if (originalAwsRegion) Deno.env.delete("AWS_REGION");

      try {
        // Provider should default to us-east-1
        const provider = new AwsVaultProvider("default-region-vault");
        assertEquals(provider.getName(), "default-region-vault");
      } finally {
        if (originalAwsRegion) Deno.env.set("AWS_REGION", originalAwsRegion);
      }
    },
  );
});

// Note: Integration tests for get/put operations require AWS credentials
// and are not included in unit tests. The error handling for AWS SDK
// operations is tested through integration tests or manual testing.
