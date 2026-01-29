const API_BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response
      .json()
      .catch(() => ({ error: "Unknown error" }));
    throw new ApiError(
      response.status,
      errorData.error || `HTTP ${response.status}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export interface ModelType {
  raw: string;
  normalized: string;
}

export interface Model {
  id: string;
  name: string;
  type: ModelType;
  version: number;
  resourceId?: string;
  tags: Record<string, string>;
  attributes: Record<string, unknown>;
}

export interface Resource {
  id: string;
  version: number;
  createdAt: string;
  attributes: Record<string, unknown>;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  version: number;
  jobCount: number;
}

export interface StepTask {
  type: "model_method" | "shell";
  modelIdOrName?: string;
  methodName?: string;
  command?: string;
  args?: string[];
  workingDir?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface TriggerCondition {
  type:
    | "always"
    | "succeeded"
    | "failed"
    | "completed"
    | "skipped"
    | "and"
    | "or"
    | "not";
  ref?: string;
  conditions?: TriggerCondition[];
  condition?: TriggerCondition;
}

export interface StepDependency {
  step: string;
  condition: TriggerCondition;
}

export interface JobDependency {
  job: string;
  condition: TriggerCondition;
}

export interface WorkflowStep {
  name: string;
  description?: string;
  task: StepTask;
  dependsOn: StepDependency[];
  weight: number;
}

export interface WorkflowJob {
  name: string;
  description?: string;
  dependsOn: JobDependency[];
  weight: number;
  steps: WorkflowStep[];
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  version: number;
  jobs: WorkflowJob[];
}

export interface CreateModelInput {
  name: string;
  version?: number;
  resourceId?: string;
  tags?: Record<string, string>;
  attributes?: Record<string, unknown>;
}

export interface UpdateModelInput {
  name?: string;
  version?: number;
  resourceId?: string;
  tags?: Record<string, string>;
  attributes?: Record<string, unknown>;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  version?: number;
  jobs?: WorkflowJob[];
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  version?: number;
  jobs?: WorkflowJob[];
}

export async function listTypes(): Promise<ModelType[]> {
  const data = await fetchJson<{ types: ModelType[] }>(`${API_BASE}/types`);
  return data.types;
}

export async function listAllModels(): Promise<Model[]> {
  const data = await fetchJson<{ models: Model[] }>(`${API_BASE}/models`);
  return data.models;
}

export async function listModelsByType(type: string): Promise<Model[]> {
  const data = await fetchJson<{ models: Model[] }>(
    `${API_BASE}/models/${encodeURIComponent(type)}`,
  );
  return data.models;
}

export async function getModel(type: string, id: string): Promise<Model> {
  return fetchJson<Model>(
    `${API_BASE}/models/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
  );
}

export async function createModel(
  type: string,
  input: CreateModelInput,
): Promise<Model> {
  return fetchJson<Model>(`${API_BASE}/models/${encodeURIComponent(type)}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateModel(
  type: string,
  id: string,
  input: UpdateModelInput,
): Promise<Model> {
  return fetchJson<Model>(
    `${API_BASE}/models/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteModel(type: string, id: string): Promise<void> {
  await fetchJson<void>(
    `${API_BASE}/models/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
}

export async function listResourcesByType(type: string): Promise<Resource[]> {
  const data = await fetchJson<{ resources: Resource[] }>(
    `${API_BASE}/resources/${encodeURIComponent(type)}`,
  );
  return data.resources;
}

export async function getResource(type: string, id: string): Promise<Resource> {
  return fetchJson<Resource>(
    `${API_BASE}/resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
  );
}

export async function deleteResource(type: string, id: string): Promise<void> {
  await fetchJson<void>(
    `${API_BASE}/resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const data = await fetchJson<{ workflows: WorkflowSummary[] }>(
    `${API_BASE}/workflows`,
  );
  return data.workflows;
}

export async function getWorkflow(id: string): Promise<Workflow> {
  return fetchJson<Workflow>(
    `${API_BASE}/workflows/${encodeURIComponent(id)}`,
  );
}

export async function createWorkflow(
  input: CreateWorkflowInput,
): Promise<Workflow> {
  return fetchJson<Workflow>(`${API_BASE}/workflows`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateWorkflow(
  id: string,
  input: UpdateWorkflowInput,
): Promise<Workflow> {
  return fetchJson<Workflow>(
    `${API_BASE}/workflows/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteWorkflow(id: string): Promise<void> {
  await fetchJson<void>(`${API_BASE}/workflows/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
