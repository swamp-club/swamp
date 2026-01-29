import { assertStringIncludes } from "@std/assert";

// Integration tests run the CLI as a subprocess to test end-to-end behavior

async function runCliCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "dev", ...args],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

Deno.test("CLI with no args shows help", async () => {
  const { stdout } = await runCliCommand([]);
  assertStringIncludes(stdout, "swamp");
  assertStringIncludes(stdout, "Usage:");
});

Deno.test("CLI with --help shows help", async () => {
  const { stdout } = await runCliCommand(["--help"]);
  assertStringIncludes(stdout, "swamp");
  assertStringIncludes(stdout, "Usage:");
  assertStringIncludes(stdout, "--json");
  assertStringIncludes(stdout, "--quiet");
  assertStringIncludes(stdout, "--verbose");
});

Deno.test("CLI with --version shows version", async () => {
  const { stdout } = await runCliCommand(["--version"]);
  assertStringIncludes(stdout, "0.1.0");
});

Deno.test("CLI version command works", async () => {
  const { stdout } = await runCliCommand(["version"]);
  assertStringIncludes(stdout, "swamp");
});

Deno.test("CLI version command with --json outputs JSON", async () => {
  const { stdout } = await runCliCommand(["--json", "version"]);
  // Should be valid JSON with version and haiku fields
  const parsed = JSON.parse(stdout);
  assertStringIncludes(parsed.version, "0.1.0");
});
