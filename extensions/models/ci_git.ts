import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  url: z.string().describe("Git repository URL"),
  workDir: z.string().optional().describe(
    "Base directory for clones (defaults to a temporary directory)",
  ),
});

const RepositorySchema = z.object({
  path: z.string(),
  sha: z.string(),
  branch: z.string(),
  remote: z.string(),
  ref: z.string(),
});

const DiffFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
});

const DiffSchema = z.object({
  base: z.string(),
  head: z.string(),
  files: z.array(DiffFileSchema),
  totalAdditions: z.number(),
  totalDeletions: z.number(),
  filesChanged: z.number(),
});

async function runGit(
  args: string[],
  opts?: { cwd?: string },
): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: opts?.cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (output.code !== 0) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

export const model = {
  type: "@swamp/ci/git",
  version: "2026.04.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "repository": {
      description: "Cloned or checked-out repository state",
      schema: RepositorySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "diff": {
      description: "Diff between two refs",
      schema: DiffSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    clone: {
      description: "Clone a git repository (idempotent — skips if directory already exists)",
      arguments: z.object({
        ref: z.string().optional().describe("Branch, tag, or commit to checkout after clone"),
        depth: z.number().optional().describe("Shallow clone depth"),
      }),
      execute: async (
        args: { ref?: string; depth?: number },
        context: {
          globalArgs: { url: string; workDir?: string };
          logger: {
            info: (msg: string, data?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<unknown>;
        },
      ) => {
        const { url, workDir } = context.globalArgs;
        const repoName = url.split("/").pop()?.replace(/\.git$/, "") ?? "repo";
        const baseDir = workDir ?? await Deno.makeTempDir({ prefix: "swamp-ci-" });
        const repoPath = `${baseDir}/${repoName}`;

        context.logger.info(`Cloning ${url} to ${repoPath}`);

        // Skip if already cloned
        try {
          const stat = await Deno.stat(repoPath);
          if (stat.isDirectory) {
            context.logger.info(
              `Repository already exists at ${repoPath}, fetching latest`,
            );
            await runGit(["fetch", "--all"], { cwd: repoPath });
            if (args.ref) {
              await runGit(["checkout", args.ref], { cwd: repoPath });
            }
          }
        } catch {
          // Directory doesn't exist, proceed with clone
          const cloneArgs = ["clone"];
          if (args.depth) {
            cloneArgs.push("--depth", String(args.depth));
          }
          if (args.ref) {
            cloneArgs.push("--branch", args.ref);
          }
          cloneArgs.push(url, repoPath);
          await runGit(cloneArgs);
        }

        // If ref is a specific commit (not a branch/tag), checkout after clone
        if (args.ref && args.ref.match(/^[0-9a-f]{7,40}$/)) {
          await runGit(["checkout", args.ref], { cwd: repoPath });
        }

        const sha = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
        const branch = await runGit(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd: repoPath },
        ).catch(() => "HEAD");
        const remote = await runGit(
          ["remote", "get-url", "origin"],
          { cwd: repoPath },
        ).catch(() => url);

        context.logger.info(`Cloned ${url} at ${sha}`);

        const handle = await context.writeResource("repository", "repository", {
          path: repoPath,
          sha,
          branch,
          remote,
          ref: args.ref ?? branch,
        });
        return { dataHandles: [handle] };
      },
    },

    checkout: {
      description: "Checkout a specific ref in an existing repository",
      arguments: z.object({
        path: z.string().describe("Path to the git repository"),
        ref: z.string().describe("Branch, tag, or commit SHA to checkout"),
      }),
      execute: async (
        args: { path: string; ref: string },
        context: {
          globalArgs: { url: string };
          logger: {
            info: (msg: string, data?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<unknown>;
        },
      ) => {
        context.logger.info(`Checking out ${args.ref} in ${args.path}`);

        await runGit(["checkout", args.ref], { cwd: args.path });

        const sha = await runGit(["rev-parse", "HEAD"], { cwd: args.path });
        const branch = await runGit(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd: args.path },
        ).catch(() => "HEAD");
        const remote = await runGit(
          ["remote", "get-url", "origin"],
          { cwd: args.path },
        ).catch(() => context.globalArgs.url);

        context.logger.info(`Checked out ${args.ref} at ${sha}`);

        const handle = await context.writeResource("repository", "repository", {
          path: args.path,
          sha,
          branch,
          remote,
          ref: args.ref,
        });
        return { dataHandles: [handle] };
      },
    },

    fetch: {
      description: "Fetch latest refs from a remote",
      arguments: z.object({
        path: z.string().describe("Path to the git repository"),
        remote: z.string().default("origin").describe("Remote name"),
        ref: z.string().optional().describe("Specific ref to fetch"),
      }),
      execute: async (
        args: { path: string; remote: string; ref?: string },
        context: {
          globalArgs: { url: string };
          logger: {
            info: (msg: string, data?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<unknown>;
        },
      ) => {
        const fetchArgs = ["fetch", args.remote];
        if (args.ref) {
          fetchArgs.push(args.ref);
        }

        context.logger.info(`Fetching from ${args.remote}`);

        await runGit(fetchArgs, { cwd: args.path });

        const sha = await runGit(["rev-parse", "HEAD"], { cwd: args.path });
        const branch = await runGit(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd: args.path },
        ).catch(() => "HEAD");
        const remote = await runGit(
          ["remote", "get-url", args.remote],
          { cwd: args.path },
        ).catch(() => context.globalArgs.url);

        const handle = await context.writeResource("repository", "repository", {
          path: args.path,
          sha,
          branch,
          remote,
          ref: branch,
        });
        return { dataHandles: [handle] };
      },
    },

    diff: {
      description: "Show diff stats between two refs",
      arguments: z.object({
        path: z.string().describe("Path to the git repository"),
        base: z.string().describe("Base ref (branch, tag, or SHA)"),
        head: z.string().default("HEAD").describe("Head ref to compare against"),
      }),
      execute: async (
        args: { path: string; base: string; head: string },
        context: {
          logger: {
            info: (msg: string, data?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<unknown>;
        },
      ) => {
        context.logger.info(`Computing diff ${args.base}..${args.head}`);

        const numstat = await runGit(
          ["diff", "--numstat", `${args.base}...${args.head}`],
          { cwd: args.path },
        );

        const files = numstat
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            const [additions, deletions, path] = line.split("\t");
            return {
              path: path ?? "",
              status: "modified",
              additions: additions === "-" ? 0 : parseInt(additions, 10),
              deletions: deletions === "-" ? 0 : parseInt(deletions, 10),
            };
          });

        const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
        const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

        context.logger.info(
          `Diff: ${files.length} files, +${totalAdditions} -${totalDeletions}`,
        );

        const handle = await context.writeResource("diff", "diff", {
          base: args.base,
          head: args.head,
          files,
          totalAdditions,
          totalDeletions,
          filesChanged: files.length,
        });
        return { dataHandles: [handle] };
      },
    },

    clean: {
      description: "Remove a cloned repository directory",
      arguments: z.object({
        path: z.string().describe("Path to the repository to remove"),
      }),
      execute: async (
        args: { path: string },
        context: {
          logger: {
            info: (msg: string, data?: Record<string, unknown>) => void;
          };
        },
      ) => {
        context.logger.info(`Removing ${args.path}`);
        await Deno.remove(args.path, { recursive: true });
        context.logger.info(`Cleaned up ${args.path}`);
        return { dataHandles: [] };
      },
    },
  },
};
