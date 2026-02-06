<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter, RouterLink } from "vue-router";
import {
  deleteWorkflow,
  getWorkflow,
  getModel,
  lookupModel,
  type Model,
  type TriggerCondition,
  type Workflow,
} from "../../api/client";

const route = useRoute();
const router = useRouter();
const workflow = ref<Workflow | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const deleting = ref(false);
const expandedSteps = ref<Set<string>>(new Set());
const modelLinks = ref<Map<string, { type: string; id: string }>>(new Map());
const modelDetails = ref<Map<string, Model>>(new Map());

const idParam = route.params.id as string;

onMounted(async () => {
  try {
    workflow.value = await getWorkflow(idParam);

    // Resolve model links and fetch model details for all model_method steps
    if (workflow.value) {
      for (const job of workflow.value.jobs) {
        for (const step of job.steps) {
          if (step.task.type === "model_method" && step.task.modelIdOrName) {
            try {
              const lookup = await lookupModel(step.task.modelIdOrName);
              modelLinks.value.set(step.task.modelIdOrName, {
                type: lookup.type,
                id: lookup.id,
              });
              // Fetch full model details to get attributes
              const model = await getModel(lookup.type, lookup.id);
              modelDetails.value.set(step.task.modelIdOrName, model);
            } catch {
              // Model not found, link will be disabled
            }
          }
        }
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load workflow";
  } finally {
    loading.value = false;
  }
});

async function handleDelete() {
  if (!confirm("Are you sure you want to delete this workflow?")) return;

  deleting.value = true;
  try {
    await deleteWorkflow(idParam);
    router.push({ name: "workflows" });
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to delete workflow";
    deleting.value = false;
  }
}

function toggleStep(jobName: string, stepName: string) {
  const key = `${jobName}:${stepName}`;
  if (expandedSteps.value.has(key)) {
    expandedSteps.value.delete(key);
  } else {
    expandedSteps.value.add(key);
  }
}

function isStepExpanded(jobName: string, stepName: string): boolean {
  return expandedSteps.value.has(`${jobName}:${stepName}`);
}

function formatCondition(condition: TriggerCondition): string {
  if (condition.type === "and" || condition.type === "or") {
    const parts = condition.conditions?.map(formatCondition) || [];
    return parts.join(` ${condition.type} `);
  }
  if (condition.type === "not") {
    return `not(${formatCondition(condition.condition!)})`;
  }
  return condition.type;
}

function getModelLink(modelIdOrName: string): { name: string; params: { type: string; id: string } } | null {
  const link = modelLinks.value.get(modelIdOrName);
  if (!link) return null;
  return { name: "model-detail", params: { type: link.type, id: link.id } };
}

function getModelAttributes(modelIdOrName: string): Record<string, unknown> | null {
  const model = modelDetails.value.get(modelIdOrName);
  return model?.attributes ?? null;
}
</script>

<template>
  <div>
    <div class="mb-6">
      <RouterLink to="/workflows" class="text-blue-600 hover:text-blue-800 text-sm">
        &larr; Back to Workflows
      </RouterLink>
    </div>

    <div v-if="error" class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
      {{ error }}
    </div>

    <div v-if="loading" class="text-gray-500">Loading...</div>

    <div v-else-if="workflow" class="space-y-6">
      <div class="bg-white rounded-lg shadow">
        <div class="px-6 py-4 border-b border-gray-200">
          <div class="flex items-center justify-between">
            <h1 class="text-2xl font-bold text-gray-900">{{ workflow.name }}</h1>
            <div class="space-x-2">
              <RouterLink
                :to="{ name: 'workflow-edit', params: { id: idParam } }"
                class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
              >
                Edit
              </RouterLink>
              <button
                @click="handleDelete"
                :disabled="deleting"
                class="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {{ deleting ? "Deleting..." : "Delete" }}
              </button>
            </div>
          </div>
        </div>

        <div class="p-6 space-y-6">
          <div class="grid grid-cols-2 gap-6">
            <div>
              <div class="text-sm font-medium text-gray-500">ID</div>
              <div class="mt-1 text-sm text-gray-900 font-mono">{{ workflow.id }}</div>
            </div>
            <div>
              <div class="text-sm font-medium text-gray-500">Version</div>
              <div class="mt-1 text-sm text-gray-900">{{ workflow.version }}</div>
            </div>
          </div>

          <div v-if="workflow.description">
            <div class="text-sm font-medium text-gray-500">Description</div>
            <div class="mt-1 text-sm text-gray-900">{{ workflow.description }}</div>
          </div>
        </div>
      </div>

      <div class="bg-white rounded-lg shadow">
        <div class="px-6 py-4 border-b border-gray-200">
          <h2 class="text-lg font-semibold text-gray-900">Jobs ({{ workflow.jobs.length }})</h2>
        </div>
        <div class="divide-y divide-gray-200">
          <div v-for="job in workflow.jobs" :key="job.name" class="p-6">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-md font-medium text-gray-900">{{ job.name }}</h3>
              <span class="text-sm text-gray-500">{{ job.steps.length }} step(s)</span>
            </div>
            <p v-if="job.description" class="text-sm text-gray-600 mb-4">{{ job.description }}</p>

            <div class="space-y-3">
              <div
                v-for="step in job.steps"
                :key="step.name"
                class="bg-gray-50 rounded p-3 cursor-pointer hover:bg-gray-100 transition-colors"
                @click="toggleStep(job.name, step.name)"
              >
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <svg
                      class="w-4 h-4 text-gray-400 transition-transform"
                      :class="{ 'rotate-90': isStepExpanded(job.name, step.name) }"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                    <span class="text-sm font-medium text-gray-800">{{ step.name }}</span>
                  </div>
                  <span class="text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded">
                    {{ step.task.type }}
                  </span>
                </div>
                <div v-if="step.task.type === 'model_method'" class="text-xs text-gray-600 mt-1 ml-6 font-mono">
                  {{ getModelAttributes(step.task.modelIdOrName!)?.run || `${step.task.modelIdOrName}.${step.task.methodName}()` }}
                </div>
                <div
                  v-else-if="step.task.type === 'shell'"
                  class="text-xs text-gray-600 mt-1 ml-6 font-mono"
                >
                  {{ step.task.command }} {{ (step.task.args || []).join(" ") }}
                </div>

                <!-- Expanded details section -->
                <div
                  v-if="isStepExpanded(job.name, step.name)"
                  class="mt-3 pt-3 border-t border-gray-200 ml-6"
                >
                  <!-- Description -->
                  <div v-if="step.description" class="mb-3">
                    <div class="text-xs font-medium text-gray-500">Description</div>
                    <div class="text-sm text-gray-700 mt-1">{{ step.description }}</div>
                  </div>

                  <!-- Task Configuration -->
                  <div class="mb-3">
                    <div class="text-xs font-medium text-gray-500">Task Configuration</div>
                    <dl class="mt-1 text-xs grid grid-cols-2 gap-x-4 gap-y-1">
                      <template v-if="step.task.type === 'model_method'">
                        <dt class="text-gray-500">Model:</dt>
                        <dd class="font-mono">
                          <RouterLink
                            v-if="getModelLink(step.task.modelIdOrName!)"
                            :to="getModelLink(step.task.modelIdOrName!)!"
                            class="text-blue-600 hover:text-blue-800 hover:underline"
                            @click.stop
                          >
                            {{ step.task.modelIdOrName }}
                          </RouterLink>
                          <span v-else>{{ step.task.modelIdOrName }}</span>
                        </dd>
                        <dt class="text-gray-500">Method:</dt>
                        <dd class="font-mono">{{ step.task.methodName }}</dd>
                        <template v-if="getModelAttributes(step.task.modelIdOrName!)?.run">
                          <dt class="text-gray-500">Command:</dt>
                          <dd class="font-mono">{{ getModelAttributes(step.task.modelIdOrName!)?.run }}</dd>
                        </template>
                        <template v-if="getModelAttributes(step.task.modelIdOrName!)?.workingDir">
                          <dt class="text-gray-500">Working Dir:</dt>
                          <dd class="font-mono">{{ getModelAttributes(step.task.modelIdOrName!)?.workingDir }}</dd>
                        </template>
                      </template>
                      <template v-else-if="step.task.type === 'shell'">
                        <dt class="text-gray-500">Command:</dt>
                        <dd class="font-mono">{{ step.task.command }}</dd>
                        <template v-if="step.task.args?.length">
                          <dt class="text-gray-500">Args:</dt>
                          <dd class="font-mono">{{ step.task.args.join(" ") }}</dd>
                        </template>
                      </template>
                      <template v-if="step.task.workingDir">
                        <dt class="text-gray-500">Working Dir:</dt>
                        <dd class="font-mono">{{ step.task.workingDir }}</dd>
                      </template>
                      <template v-if="step.task.timeout">
                        <dt class="text-gray-500">Timeout:</dt>
                        <dd>{{ step.task.timeout }}ms</dd>
                      </template>
                    </dl>
                    <div
                      v-if="step.task.env && Object.keys(step.task.env).length > 0"
                      class="mt-2"
                    >
                      <div class="text-xs text-gray-500">Environment:</div>
                      <div class="font-mono text-xs mt-1 bg-white rounded p-2">
                        <div v-for="(value, key) in step.task.env" :key="key">
                          {{ key }}={{ value }}
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- Dependencies -->
                  <div v-if="step.dependsOn.length > 0" class="mb-3">
                    <div class="text-xs font-medium text-gray-500">Dependencies</div>
                    <ul class="mt-1 text-xs space-y-1">
                      <li v-for="dep in step.dependsOn" :key="dep.step" class="text-gray-700">
                        <span class="font-medium">{{ dep.step }}</span>
                        <span class="text-gray-500 ml-1">({{ formatCondition(dep.condition) }})</span>
                      </li>
                    </ul>
                  </div>

                  <!-- Weight -->
                  <div class="text-xs text-gray-500">
                    Weight: {{ step.weight }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="workflow.jobs.length === 0" class="p-6 text-center text-gray-500">
            No jobs defined
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
