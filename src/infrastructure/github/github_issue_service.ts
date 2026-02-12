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

/**
 * Result of creating a GitHub issue.
 */
export interface GitHubIssueResult {
  url: string;
  number: number;
}

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
   */
  async checkGhCli(): Promise<void> {
    // Check if gh is installed
    const whichCommand = new Deno.Command("which", {
      args: ["gh"],
      stdout: "null",
      stderr: "null",
    });
    const { success: ghInstalled } = await whichCommand.output();
    if (!ghInstalled) {
      throw new UserError(
        "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
      );
    }

    // Check if gh is authenticated
    const authCommand = new Deno.Command("gh", {
      args: ["auth", "status"],
      stdout: "null",
      stderr: "null",
    });
    const { success: ghAuthenticated } = await authCommand.output();
    if (!ghAuthenticated) {
      throw new UserError(
        "GitHub CLI is not authenticated. Run 'gh auth login' to authenticate.",
      );
    }
  }

  /**
   * Creates a GitHub issue using the gh CLI.
   *
   * @param options - The issue creation options
   * @returns The URL and number of the created issue
   */
  async createIssue(options: CreateIssueOptions): Promise<GitHubIssueResult> {
    await this.checkGhCli();

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

    return { url, number };
  }
}
