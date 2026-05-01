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

import { UserError } from "../../domain/errors.ts";
import { defaultCommandResolver } from "../process/resolve_command.ts";

/**
 * Result of creating a GitHub issue.
 * Discriminated union: "created" when gh CLI was used, "url" when falling back to a browser URL.
 */
export type GitHubIssueResult =
  | { method: "created"; url: string; number: number }
  | {
    method: "url";
    url: string;
    title: string;
    body: string;
    labels: string[];
  };

/**
 * Options for creating a GitHub issue.
 */
export interface CreateIssueOptions {
  title: string;
  body: string;
  labels: string[];
  repo?: string;
}

/**
 * Service for interacting with GitHub issues via the gh CLI.
 */
export class GitHubIssueService {
  private readonly defaultRepo = "systeminit/swamp";

  /**
   * Checks if the gh CLI is installed and authenticated.
   * Returns true if available, false otherwise.
   */
  async isAvailable(): Promise<boolean> {
    const ghPath = await defaultCommandResolver().resolve("gh");
    if (!ghPath) {
      return false;
    }

    const authCommand = new Deno.Command("gh", {
      args: ["auth", "status"],
      stdout: "null",
      stderr: "null",
    });
    const { success: ghAuthenticated } = await authCommand.output();
    return ghAuthenticated;
  }

  /**
   * Returns a GitHub "new issue" URL with labels pre-filled.
   */
  getNewIssueUrl(options: { repo?: string; labels: string[] }): string {
    const repo = options.repo ?? this.defaultRepo;
    const params = new URLSearchParams();
    if (options.labels.length > 0) {
      params.set("labels", options.labels.join(","));
    }
    const query = params.toString();
    return query
      ? `https://github.com/${repo}/issues/new?${query}`
      : `https://github.com/${repo}/issues/new`;
  }

  /**
   * Creates a GitHub issue using the gh CLI.
   * Falls back to returning a pre-filled URL if the gh CLI is unavailable.
   *
   * @param options - The issue creation options
   * @returns The result, either a created issue or a fallback URL
   */
  async createIssue(options: CreateIssueOptions): Promise<GitHubIssueResult> {
    const available = await this.isAvailable();
    if (!available) {
      return {
        method: "url",
        url: this.getNewIssueUrl({
          repo: options.repo,
          labels: options.labels,
        }),
        title: options.title,
        body: options.body,
        labels: options.labels,
      };
    }

    const repo = options.repo ?? this.defaultRepo;

    const args = [
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      options.title,
      "--body",
      options.body,
    ];

    // Add labels
    for (const label of options.labels) {
      args.push("--label", label);
    }

    const command = new Deno.Command("gh", {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    const { success, stdout, stderr } = await command.output();

    if (!success) {
      const errorMessage = new TextDecoder().decode(stderr);
      throw new UserError(`Failed to create GitHub issue: ${errorMessage}`);
    }

    // gh issue create returns the URL of the created issue
    const url = new TextDecoder().decode(stdout).trim();

    // Extract issue number from URL (e.g., https://github.com/owner/repo/issues/123)
    const match = url.match(/\/issues\/(\d+)$/);
    const number = match ? parseInt(match[1], 10) : 0;

    return { method: "created", url, number };
  }
}
