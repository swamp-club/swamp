import { assertEquals, assertThrows } from "@std/assert";
import { RepoPath } from "./repo_path.ts";

Deno.test("RepoPath.create accepts absolute path", () => {
  const path = RepoPath.create("/home/user/repo");
  assertEquals(path.value, "/home/user/repo");
  assertEquals(path.toString(), "/home/user/repo");
});

Deno.test("RepoPath.create converts relative path to absolute", () => {
  const path = RepoPath.create("./my-repo");
  // Should be absolute (starts with /)
  assertEquals(path.value.startsWith("/"), true);
  // Should contain the relative path component
  assertEquals(path.value.includes("my-repo"), true);
});

Deno.test("RepoPath.create converts bare relative path to absolute", () => {
  const path = RepoPath.create("my-repo");
  assertEquals(path.value.startsWith("/"), true);
  assertEquals(path.value.endsWith("my-repo"), true);
});

Deno.test("RepoPath.create trims whitespace", () => {
  const path = RepoPath.create("  /home/user/repo  ");
  assertEquals(path.value, "/home/user/repo");
});

Deno.test("RepoPath.create throws on empty string", () => {
  assertThrows(
    () => RepoPath.create(""),
    Error,
    "Repository path cannot be empty",
  );
});

Deno.test("RepoPath.create throws on whitespace-only string", () => {
  assertThrows(
    () => RepoPath.create("   "),
    Error,
    "Repository path cannot be empty",
  );
});

Deno.test("RepoPath.equals returns true for same paths", () => {
  const p1 = RepoPath.create("/home/user/repo");
  const p2 = RepoPath.create("/home/user/repo");
  assertEquals(p1.equals(p2), true);
});

Deno.test("RepoPath.equals returns false for different paths", () => {
  const p1 = RepoPath.create("/home/user/repo1");
  const p2 = RepoPath.create("/home/user/repo2");
  assertEquals(p1.equals(p2), false);
});
