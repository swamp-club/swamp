#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
/**
 * CI check script to verify registry.generated.ts is up-to-date.
 *
 * This script:
 * 1. Saves the current registry.generated.ts content
 * 2. Runs the generator
 * 3. Compares the output
 * 4. Restores the original and exits with error if different
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-run scripts/check_model_registry.ts
 *
 * Or via task:
 *   deno task check:models
 */

const REGISTRY_FILE = new URL(
  "../src/domain/models/registry.generated.ts",
  import.meta.url,
).pathname;

const GENERATOR_SCRIPT = new URL(
  "./generate_model_registry.ts",
  import.meta.url,
).pathname;

async function main() {
  console.log("🔍 Checking if registry.generated.ts is up-to-date...\n");

  // Read current content
  let originalContent: string;
  try {
    originalContent = await Deno.readTextFile(REGISTRY_FILE);
  } catch {
    console.error("❌ registry.generated.ts not found!");
    console.error("   Run `deno task generate:models` to create it.");
    Deno.exit(1);
  }

  // Run the generator
  const command = new Deno.Command("deno", {
    args: ["run", "--allow-read", "--allow-write", GENERATOR_SCRIPT],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    console.error("❌ Generator failed:");
    console.error(new TextDecoder().decode(stderr));
    Deno.exit(1);
  }

  // Show generator output
  console.log(new TextDecoder().decode(stdout));

  // Read new content
  const newContent = await Deno.readTextFile(REGISTRY_FILE);

  // Compare
  if (originalContent === newContent) {
    console.log("✅ registry.generated.ts is up-to-date!");
    Deno.exit(0);
  } else {
    // Restore original
    await Deno.writeTextFile(REGISTRY_FILE, originalContent);

    console.error("❌ registry.generated.ts is out of date!");
    console.error("");
    console.error(
      "   The generated registry does not match the committed file.",
    );
    console.error("   This usually means a model was added or removed without");
    console.error("   regenerating the registry.");
    console.error("");
    console.error("   To fix, run:");
    console.error("     deno task generate:models");
    console.error("");
    console.error("   Then commit the updated registry.generated.ts file.");
    Deno.exit(1);
  }
}

main();
