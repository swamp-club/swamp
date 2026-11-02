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

export interface ExtractedArgument {
  name: string;
  type: string;
  description: string;
  required: boolean;
  /** omitted when not sensitive, so the metadata of other fields is unchanged */
  sensitive?: true;
}

export interface ExtractedMethod {
  name: string;
  description: string;
  arguments: ExtractedArgument[];
}

export interface ExtractedResource {
  key: string;
  description: string;
  lifetime: string;
}

export interface ExtractedFile {
  key: string;
  description: string;
  contentType: string;
}

export interface ExtractedModel {
  fileName: string;
  type: string;
  version: string;
  globalArguments: ExtractedArgument[];
  methods: ExtractedMethod[];
  resources: ExtractedResource[];
  files: ExtractedFile[];
}

export interface ExtractedWorkflowStep {
  name: string;
  description: string;
  taskType: string;
  modelIdOrName: string;
  methodName: string;
}

export interface ExtractedWorkflowJob {
  name: string;
  description: string;
  steps: ExtractedWorkflowStep[];
}

export interface ExtractedWorkflow {
  fileName: string;
  id: string;
  name: string;
  description: string;
  jobs: ExtractedWorkflowJob[];
}

export interface ExtractedVault {
  fileName: string;
  type: string;
  name: string;
  description: string;
  hasConfigSchema: boolean;
  configFields: ExtractedArgument[];
}

export interface ExtractedDatastore {
  fileName: string;
  type: string;
  name: string;
  description: string;
  hasConfigSchema: boolean;
  configFields: ExtractedArgument[];
}

export interface ExtractedReport {
  fileName: string;
  name: string;
  description: string;
  scope: string;
  labels: string[];
}

export interface ExtractedWebhook {
  fileName: string;
  type: string;
  name: string;
  description: string;
}

export interface ExtractedExtension {
  fileName: string;
  extendsType: string;
  methods: ExtractedMethod[];
  resources: ExtractedResource[];
}

export interface ExtractedSkill {
  dirName: string;
  name: string;
  description: string;
  hasScripts: boolean;
  fileCount: number;
}

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
   * filled by push at prepare time so the registry can show what the author
   * acknowledged; absent when the extension declares nothing
   */
  acceptances?: ExtensionAcceptances;
}

export interface ExtensionAcceptance {
  rule: string;
  file?: string;
  line?: number;
  reason?: string;
  source: "inline" | "sidecar" | "generated";
}

export interface ExtensionAcceptances {
  accepted: ExtensionAcceptance[];
  generated?: { by: string; source: string; commit: string };
  /**
   * set only when read back from the registry, which caps the entries it keeps;
   * push never sends it
   */
  total?: number;
}
