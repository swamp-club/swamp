// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import type {
  ExtensionContentMetadata,
  ExtractedMethod,
} from "./extension_content.ts";

/**
 * copied from validateContentMetadata in swamp-club
 * lib/domain/extension/extension-content.ts, which rejects the whole listing on
 * the first breach; limits it truncates rather than rejects are left out
 */
export const REGISTRY_LISTING_LIMITS = {
  models: 50,
  extensions: 50,
  workflows: 50,
  vaults: 20,
  datastores: 20,
  reports: 50,
  skills: 30,
  webhooks: 20,
  globalArgumentsPerModel: 30,
  methodsPerModel: 50,
  argumentsPerMethod: 30,
  resourcesPerModel: 100,
  filesPerModel: 100,
  jobsPerWorkflow: 20,
  stepsPerJob: 50,
  configFieldsPerVault: 30,
  configFieldsPerDatastore: 30,
  labelsPerReport: 20,
} as const;

export interface ListingLimitBreach {
  /** the registry's field name for the list, e.g. models or arguments */
  list: string;
  limit: number;
  count: number;
  /** the content item the list belongs to; absent for a top-level kind */
  owner?: string;
}

/** every breach, not just the first, so the author can fix them in one pass */
export function registryListingLimitBreaches(
  metadata: ExtensionContentMetadata,
): ListingLimitBreach[] {
  const L = REGISTRY_LISTING_LIMITS;
  const breaches: ListingLimitBreach[] = [];
  const check = (
    list: string,
    count: number,
    limit: number,
    owner?: string,
  ): void => {
    if (count > limit) {
      breaches.push({ list, limit, count, ...(owner ? { owner } : {}) });
    }
  };
  const checkMethods = (methods: ExtractedMethod[], owner: string): void => {
    check("methods", methods.length, L.methodsPerModel, owner);
    for (const method of methods) {
      check(
        "arguments",
        method.arguments.length,
        L.argumentsPerMethod,
        `method ${method.name} of ${owner}`,
      );
    }
  };

  check("models", metadata.models.length, L.models);
  check("extensions", metadata.extensions.length, L.extensions);
  check("workflows", metadata.workflows.length, L.workflows);
  check("vaults", metadata.vaults.length, L.vaults);
  check("datastores", metadata.datastores.length, L.datastores);
  check("reports", metadata.reports.length, L.reports);
  check("skills", metadata.skills.length, L.skills);
  check("webhooks", metadata.webhooks.length, L.webhooks);

  for (const model of metadata.models) {
    const owner = `behavior ${model.type} (${model.fileName})`;
    check(
      "globalArguments",
      model.globalArguments.length,
      L.globalArgumentsPerModel,
      owner,
    );
    checkMethods(model.methods, owner);
    check("resources", model.resources.length, L.resourcesPerModel, owner);
    check("files", model.files.length, L.filesPerModel, owner);
  }
  for (const extension of metadata.extensions) {
    const owner =
      `extension of ${extension.extendsType} (${extension.fileName})`;
    checkMethods(extension.methods, owner);
    check(
      "resources",
      extension.resources.length,
      L.resourcesPerModel,
      owner,
    );
  }
  for (const workflow of metadata.workflows) {
    const owner = `workflow ${workflow.name} (${workflow.fileName})`;
    check("jobs", workflow.jobs.length, L.jobsPerWorkflow, owner);
    for (const job of workflow.jobs) {
      check(
        "steps",
        job.steps.length,
        L.stepsPerJob,
        `job ${job.name} of ${owner}`,
      );
    }
  }
  for (const vault of metadata.vaults) {
    check(
      "configFields",
      vault.configFields.length,
      L.configFieldsPerVault,
      `vault ${vault.type} (${vault.fileName})`,
    );
  }
  for (const datastore of metadata.datastores) {
    check(
      "configFields",
      datastore.configFields.length,
      L.configFieldsPerDatastore,
      `datastore ${datastore.type} (${datastore.fileName})`,
    );
  }
  for (const report of metadata.reports) {
    check(
      "labels",
      report.labels.length,
      L.labelsPerReport,
      `report ${report.name} (${report.fileName})`,
    );
  }
  return breaches;
}
