import { z } from "zod";
import { ModelType } from "../../../src/domain/models/model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
} from "../../../src/domain/models/model.ts";
import type { Definition } from "../../../src/domain/definitions/definition.ts";

/**
 * Schema for GitHub PR list model input attributes.
 */
const InputAttributesSchema = z.object({
  /** GitHub repository owner */
  owner: z.string().min(1),
  /** GitHub repository name */
  repo: z.string().min(1),
  /** PR state filter */
  state: z.enum(["open", "closed", "all"]).default("closed"),
  /** Only return PRs updated after this ISO date */
  since: z.string().datetime().optional(),
  /** Maximum number of PRs to fetch */
  limit: z.number().int().positive().default(100),
});

type InputAttributes = z.infer<typeof InputAttributesSchema>;

interface GitHubPR {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  updated_at: string;
  user: { login: string } | null;
  body: string | null;
}

/**
 * Fetches pull requests using GitHub REST API.
 * Uses GITHUB_TOKEN environment variable for authentication.
 */
async function fetchPullRequests(attrs: InputAttributes): Promise<GitHubPR[]> {
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }

  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const allPRs: GitHubPR[] = [];
  let page = 1;
  const perPage = Math.min(attrs.limit, 100);

  // Default to 24 hours ago if since not provided
  const sinceDate = attrs.since
    ? new Date(attrs.since)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);

  while (allPRs.length < attrs.limit) {
    const url = new URL(
      `https://api.github.com/repos/${attrs.owner}/${attrs.repo}/pulls`,
    );
    url.searchParams.set("state", attrs.state);
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", perPage.toString());
    url.searchParams.set("page", page.toString());

    const response = await fetch(url.toString(), { headers });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error (${response.status}): ${text}`);
    }

    const prs = (await response.json()) as GitHubPR[];

    if (prs.length === 0) break;

    // Filter by since date and add to results
    for (const pr of prs) {
      if (new Date(pr.updated_at) < sinceDate) {
        // PRs are sorted by updated_at desc, so we can stop here
        return allPRs.slice(0, attrs.limit);
      }
      if (allPRs.length < attrs.limit) {
        allPRs.push(pr);
      }
    }

    page++;
  }

  return allPRs.slice(0, attrs.limit);
}

/**
 * Execute the list method.
 */
async function executeList(
  definition: Definition,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(definition.attributes);
  const prs = await fetchPullRequests(attrs);

  const pullRequests = prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    mergedAt: pr.merged_at,
    author: pr.user?.login ?? "unknown",
    body: pr.body,
  }));

  const dataAttributes = {
    pullRequests,
    fetchedAt: new Date().toISOString(),
    owner: attrs.owner,
    repo: attrs.repo,
  };

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(JSON.stringify(dataAttributes)),
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: { type: "data" },
        ownerDefinition: {
          definitionHash,
          ownerType: "model-method",
          ownerRef: "list",
        },
      },
    }],
  };
}

/**
 * GitHub PR List model definition.
 *
 * Fetches pull requests from a GitHub repository using the GitHub REST API.
 * Requires GITHUB_TOKEN environment variable to be set.
 */
export const githubPrListModel = defineModel({
  type: ModelType.create("github/pr-list"),
  version: 1,
  inputAttributesSchema: InputAttributesSchema,
  methods: {
    list: {
      description: "List pull requests from a GitHub repository",
      inputAttributesSchema: InputAttributesSchema,
      execute: executeList,
    },
  },
});
