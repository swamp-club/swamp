import { assertEquals } from "@std/assert";
import { containsVaultExpression } from "./expression_evaluation_service.ts";

Deno.test("containsVaultExpression returns true for vault-only expressions", () => {
  assertEquals(containsVaultExpression("vault.get(aws, myKey)"), true);
  assertEquals(
    containsVaultExpression("vault.get('aws', 'myKey')"),
    true,
  );
  assertEquals(
    containsVaultExpression('vault.get("aws", "myKey")'),
    true,
  );
});

Deno.test("containsVaultExpression returns true for mixed CEL+vault expressions", () => {
  assertEquals(
    containsVaultExpression(
      "model.foo.data.attributes.x + vault.get(aws, key)",
    ),
    true,
  );
});

Deno.test("containsVaultExpression returns false for CEL-only expressions", () => {
  assertEquals(
    containsVaultExpression("model.foo.data.attributes.message"),
    false,
  );
  assertEquals(containsVaultExpression("self.name"), false);
  assertEquals(containsVaultExpression("inputs.param"), false);
  assertEquals(containsVaultExpression("env.HOME"), false);
});

Deno.test("containsVaultExpression returns false for vault-like but not vault.get", () => {
  assertEquals(containsVaultExpression("vault.name"), false);
  assertEquals(containsVaultExpression("vault_get(foo)"), false);
});
