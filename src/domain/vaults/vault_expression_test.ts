import { assertRejects, assertStringIncludes } from "@std/assert";
import { VaultService } from "./vault_service.ts";

Deno.test("Direct Vault Service Error Messages", async (t) => {
  await t.step(
    "should provide detailed error for missing vault configuration",
    async () => {
      const vaultService = new VaultService();

      const error = await assertRejects(
        () => vaultService.get("production", "api-key"),
        Error,
      );

      // Test the detailed error message format
      assertStringIncludes(
        error.message,
        "Vault 'production' not found. No vaults are configured.",
      );
      assertStringIncludes(
        error.message,
        "Add vault configuration to your .swamp.yaml file:",
      );
      assertStringIncludes(error.message, "vaults:");
      assertStringIncludes(error.message, "production:");
      assertStringIncludes(error.message, "type: aws");
      assertStringIncludes(error.message, "config:");
      assertStringIncludes(error.message, "region: us-east-1");
      assertStringIncludes(
        error.message,
        "Or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables",
      );
    },
  );

  await t.step(
    "should provide specific vault name in error message",
    async () => {
      const vaultService = new VaultService();

      // Test with a different vault name to ensure it's dynamic
      const error = await assertRejects(
        () => vaultService.get("my-custom-vault", "secret-key"),
        Error,
      );

      assertStringIncludes(error.message, "Vault 'my-custom-vault' not found");
      assertStringIncludes(error.message, "my-custom-vault:");
    },
  );
});
