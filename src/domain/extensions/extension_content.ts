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

/** A single argument extracted from a method's Zod schema. */
export interface ExtractedArgument {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

/** A method extracted from a model definition. */
export interface ExtractedMethod {
  name: string;
  description: string;
  arguments: ExtractedArgument[];
}

/** A resource output spec extracted from a model definition. */
export interface ExtractedResource {
  key: string;
  description: string;
  lifetime: string;
}

/** A file output spec extracted from a model definition. */
export interface ExtractedFile {
  key: string;
  description: string;
  contentType: string;
}

/** Metadata extracted from a single model TypeScript file. */
export interface ExtractedModel {
  fileName: string;
  type: string;
  version: string;
  globalArguments: ExtractedArgument[];
  methods: ExtractedMethod[];
  resources: ExtractedResource[];
  files: ExtractedFile[];
}

/** A single step extracted from a workflow job. */
export interface ExtractedWorkflowStep {
  name: string;
  description: string;
  taskType: string;
  modelIdOrName: string;
  methodName: string;
}

/** A job extracted from a workflow definition. */
export interface ExtractedWorkflowJob {
  name: string;
  description: string;
  steps: ExtractedWorkflowStep[];
}

/** Metadata extracted from a single workflow YAML file. */
export interface ExtractedWorkflow {
  fileName: string;
  id: string;
  name: string;
  description: string;
  jobs: ExtractedWorkflowJob[];
}

/** Metadata extracted from a single vault TypeScript file. */
export interface ExtractedVault {
  fileName: string;
  type: string;
  name: string;
  description: string;
  hasConfigSchema: boolean;
  configFields: ExtractedArgument[];
}

/** Metadata extracted from a single datastore TypeScript file. */
export interface ExtractedDatastore {
  fileName: string;
  type: string;
  name: string;
  description: string;
  hasConfigSchema: boolean;
  configFields: ExtractedArgument[];
}

/** Metadata extracted from a single report TypeScript file. */
export interface ExtractedReport {
  fileName: string;
  name: string;
  description: string;
  scope: string;
  labels: string[];
}

/** Metadata extracted from a single webhook TypeScript file. */
export interface ExtractedWebhook {
  fileName: string;
  type: string;
  name: string;
  description: string;
}

/** Metadata extracted from an extension file that grafts methods onto a foreign type. */
export interface ExtractedExtension {
  fileName: string;
  extendsType: string;
  methods: ExtractedMethod[];
  resources: ExtractedResource[];
}

/** Metadata extracted from a skill directory. */
export interface ExtractedSkill {
  dirName: string;
  name: string;
  description: string;
  hasScripts: boolean;
  fileCount: number;
}

/** Content metadata extracted from all models, workflows, vaults, datastores, reports, webhooks, and skills in an extension. */
export interface ExtensionContentMetadata {
  models: ExtractedModel[];
  extensions: ExtractedExtension[];
  workflows: ExtractedWorkflow[];
  vaults: ExtractedVault[];
  datastores: ExtractedDatastore[];
  reports: ExtractedReport[];
  webhooks: ExtractedWebhook[];
  skills: ExtractedSkill[];
  /**
   * The warning-level findings the author declared acceptable, with their
   * reasons, and the generated declaration when the package is generated.
   * Filled by push at prepare time so the registry can show what the author
   * acknowledged (stored server-side by swamp-club#3095). Absent when the
   * extension declares nothing.
   */
  acceptances?: ExtensionAcceptances;
}

/** One declared acceptance as the registry receives it. */
export interface ExtensionAcceptance {
  /** The rule the acceptance names, e.g. `credentials-sensitive-field`. */
  rule: string;
  /** The file's path inside the archive (`models/x.ts`); absent for extension-scoped rules or an unpackaged file. */
  file?: string;
  /** The 1-based line for a site-scoped finding. */
  line?: number;
  /** The author's reason. */
  reason: string;
  /** Where the acceptance was declared. */
  source: "inline" | "sidecar" | "generated";
}

/** The declared acceptances carried in content metadata. */
export interface ExtensionAcceptances {
  accepted: ExtensionAcceptance[];
  /** The generated declaration from the quality sidecar, when present. */
  generated?: { by: string; source: string; commit: string };
}
