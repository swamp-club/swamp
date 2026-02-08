<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import {
  listWorkflowRuns,
  listOutputs,
  getWorkflowRun,
  type WorkflowRunSummary,
  type OutputSummary,
  type WorkflowRunDetail,
} from "../../api/client";

interface ShellOutput {
  type: "shell";
  command: string;
  args: string[];
  stdout?: string;
  exitCode?: number;
}

interface ModelMethodOutput {
  type: "model_method";
  model: string;
  method: string;
  resourceId?: string;
  resourcePath?: string;
  resourceAttributes?: Record<string, unknown>;
}

function isShellOutput(output: unknown): output is ShellOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    "type" in output &&
    (output as { type: unknown }).type === "shell"
  );
}

function isModelMethodOutput(output: unknown): output is ModelMethodOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    "type" in output &&
    (output as { type: unknown }).type === "model_method"
  );
}

const router = useRouter();
const workflowRuns = ref<WorkflowRunSummary[]>([]);
const outputs = ref<OutputSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const expandedRuns = ref<Set<string>>(new Set());
const runDetails = ref<Map<string, WorkflowRunDetail>>(new Map());
const loadingRun = ref<string | null>(null);

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function formatRelativeTime(dateStr: string | undefined): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function getStatusColor(status: string): string {
  switch (status) {
    case "succeeded":
      return "text-green-600 bg-green-100";
    case "failed":
      return "text-red-600 bg-red-100";
    case "running":
      return "text-blue-600 bg-blue-100";
    case "pending":
      return "text-yellow-600 bg-yellow-100";
    default:
      return "text-gray-600 bg-gray-100";
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "succeeded":
      return "✓";
    case "failed":
      return "✗";
    case "running":
      return "●";
    case "pending":
      return "○";
    default:
      return "?";
  }
}

async function toggleRunExpanded(runId: string) {
  if (expandedRuns.value.has(runId)) {
    expandedRuns.value.delete(runId);
  } else {
    expandedRuns.value.add(runId);
    // Fetch run details if not already loaded
    if (!runDetails.value.has(runId)) {
      loadingRun.value = runId;
      try {
        const runDetail = await getWorkflowRun(runId);
        runDetails.value.set(runId, runDetail);
      } catch (e) {
        console.error("Failed to load run details:", e);
      } finally {
        loadingRun.value = null;
      }
    }
  }
}

function isRunExpanded(runId: string): boolean {
  return expandedRuns.value.has(runId);
}

function getRunDetail(runId: string): WorkflowRunDetail | undefined {
  return runDetails.value.get(runId);
}

onMounted(async () => {
  try {
    const [runsData, outputsData] = await Promise.all([
      listWorkflowRuns(),
      listOutputs(),
    ]);
    workflowRuns.value = runsData;
    outputs.value = outputsData;

    // Auto-expand the first run if there are any
    if (runsData.length > 0) {
      await toggleRunExpanded(runsData[0].id);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load data";
  } finally {
    loading.value = false;
  }
});

function handleOutputClick(outputId: string) {
  router.push({
    name: "output-detail",
    params: { id: outputId },
  });
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-3xl font-bold text-gray-900">Outputs</h1>
    </div>

    <div
      v-if="error"
      class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6"
    >
      {{ error }}
    </div>

    <div v-if="loading" class="text-gray-500">Loading...</div>

    <div v-else>
      <!-- Workflow Runs Section -->
      <div v-if="workflowRuns.length > 0" class="space-y-4">
        <h2 class="text-lg font-semibold text-gray-700 mb-3">Workflow Runs</h2>

        <div
          v-for="run in workflowRuns"
          :key="run.id"
          class="bg-white rounded-lg shadow overflow-hidden"
        >
          <!-- Run Header -->
          <div
            class="px-4 py-3 border-b border-gray-200 cursor-pointer hover:bg-gray-50"
            @click="toggleRunExpanded(run.id)"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <span
                  class="text-gray-400 transition-transform"
                  :class="{ 'rotate-90': isRunExpanded(run.id) }"
                >
                  ▶
                </span>
                <div>
                  <div class="font-medium text-gray-900">
                    {{ run.workflowName }}
                  </div>
                  <div class="text-sm text-gray-500">
                    {{ formatRelativeTime(run.startedAt) }}
                    <span class="mx-1">·</span>
                    {{ run.outputCount }} output{{
                      run.outputCount !== 1 ? "s" : ""
                    }}
                  </div>
                </div>
              </div>
              <span
                :class="[
                  'px-2 py-1 rounded-full text-xs font-medium',
                  getStatusColor(run.status),
                ]"
              >
                {{ getStatusIcon(run.status) }} {{ run.status }}
              </span>
            </div>
          </div>

          <!-- Expanded Run Details -->
          <div v-if="isRunExpanded(run.id)" class="px-4 py-3 bg-gray-50">
            <div class="text-xs text-gray-500 mb-3">
              <span>Run ID: {{ run.id.slice(0, 8) }}...</span>
              <span class="mx-2">·</span>
              <span>Started: {{ formatDate(run.startedAt) }}</span>
              <span v-if="run.completedAt" class="mx-2">·</span>
              <span v-if="run.completedAt"
                >Completed: {{ formatDate(run.completedAt) }}</span
              >
            </div>

            <!-- Loading state -->
            <div
              v-if="loadingRun === run.id"
              class="text-sm text-gray-500 py-2"
            >
              Loading details...
            </div>

            <!-- Jobs and Steps for this run -->
            <div
              v-else-if="getRunDetail(run.id)?.jobs.length"
              class="space-y-3"
            >
              <div
                v-for="job in getRunDetail(run.id)?.jobs"
                :key="job.jobName"
                class="bg-white rounded border border-gray-200 overflow-hidden"
              >
                <!-- Job Header -->
                <div
                  class="px-3 py-2 bg-gray-100 border-b border-gray-200 flex items-center justify-between"
                >
                  <span class="font-medium text-gray-700">{{
                    job.jobName
                  }}</span>
                  <span
                    :class="[
                      'px-2 py-0.5 rounded-full text-xs font-medium',
                      getStatusColor(job.status),
                    ]"
                  >
                    {{ getStatusIcon(job.status) }} {{ job.status }}
                  </span>
                </div>

                <!-- Steps -->
                <div class="divide-y divide-gray-100">
                  <div
                    v-for="step in job.steps"
                    :key="step.stepName"
                    :class="[
                      'px-3 py-2',
                      step.outputId && 'cursor-pointer hover:bg-gray-50 transition-colors',
                    ]"
                    @click="step.outputId && handleOutputClick(step.outputId)"
                  >
                    <div class="flex items-center justify-between">
                      <div class="flex items-center gap-2">
                        <span
                          :class="[
                            'w-5 h-5 rounded-full text-xs font-medium flex items-center justify-center',
                            getStatusColor(step.status),
                          ]"
                        >
                          {{ getStatusIcon(step.status) }}
                        </span>
                        <span class="text-gray-800">{{ step.stepName }}</span>

                        <!-- Task type badge -->
                        <span
                          v-if="isShellOutput(step.output)"
                          class="px-1.5 py-0.5 bg-purple-100 text-purple-700 text-xs rounded"
                        >
                          shell
                        </span>
                        <span
                          v-else-if="isModelMethodOutput(step.output)"
                          class="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded"
                        >
                          model
                        </span>
                      </div>
                    </div>

                    <!-- Step output details -->
                    <div
                      v-if="isShellOutput(step.output)"
                      class="mt-1 ml-7 text-xs text-gray-500"
                    >
                      <span class="font-mono"
                        >{{ step.output.command }}
                        {{ step.output.args.join(" ") }}</span
                      >
                      <span
                        v-if="step.output.exitCode !== undefined"
                        class="ml-2 text-gray-400"
                      >
                        → exit {{ step.output.exitCode }}
                      </span>
                      <pre
                        v-if="step.output.stdout"
                        class="mt-1 p-2 bg-gray-900 text-gray-100 rounded text-xs overflow-x-auto max-h-32"
                        >{{ step.output.stdout }}</pre
                      >
                    </div>
                    <div
                      v-else-if="isModelMethodOutput(step.output)"
                      class="mt-1 ml-7 text-xs text-gray-500"
                    >
                      <span class="font-mono"
                        >{{ step.output.model }}.{{ step.output.method }}()</span
                      >
                      <span
                        v-if="step.output.resourceId"
                        class="ml-2 text-gray-400"
                      >
                        → {{ step.output.resourceId.slice(0, 8) }}...
                      </span>
                    </div>

                    <!-- Error display -->
                    <div
                      v-if="step.error"
                      class="mt-1 ml-7 text-xs text-red-600 bg-red-50 p-2 rounded"
                    >
                      {{ step.error }}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Outputs for this run (fallback if no jobs) -->
            <div
              v-else-if="getRunDetail(run.id)?.outputs.length"
              class="space-y-2"
            >
              <div
                v-for="output in getRunDetail(run.id)?.outputs"
                :key="output.id"
                class="bg-white rounded border border-gray-200 px-3 py-2 hover:border-blue-300 cursor-pointer transition-colors"
                @click.stop="handleOutputClick(output.id)"
              >
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span
                      :class="[
                        'w-5 h-5 rounded-full text-xs font-medium flex items-center justify-center',
                        getStatusColor(output.status),
                      ]"
                    >
                      {{ getStatusIcon(output.status) }}
                    </span>
                    <div>
                      <span class="font-medium text-gray-800">{{
                        output.type
                      }}</span>
                      <span class="text-gray-400 mx-1">·</span>
                      <span class="text-gray-600">{{ output.methodName }}</span>
                      <span v-if="output.stepName" class="text-gray-400 ml-2"
                        >({{ output.stepName }})</span
                      >
                    </div>
                  </div>
                  <div class="text-sm text-gray-500">
                    {{ formatDuration(output.durationMs) }}
                  </div>
                </div>
              </div>
            </div>

            <div v-else class="text-sm text-gray-500 italic py-2">
              No details recorded for this run
            </div>
          </div>
        </div>
      </div>

      <!-- All Outputs Table (fallback/full view) -->
      <div v-if="outputs.length > 0" class="mt-8">
        <h2 class="text-lg font-semibold text-gray-700 mb-3">All Outputs</h2>

        <div class="bg-white rounded-lg shadow overflow-hidden">
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
              <tr>
                <th
                  class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Model
                </th>
                <th
                  class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Type
                </th>
                <th
                  class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Method
                </th>
                <th
                  class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Status
                </th>
                <th
                  class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Started
                </th>
                <th
                  class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Duration
                </th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              <tr
                v-for="output in outputs"
                :key="output.id"
                class="hover:bg-gray-50 cursor-pointer"
                @click="handleOutputClick(output.id)"
              >
                <td class="px-4 py-3 whitespace-nowrap">
                  <span class="text-gray-900">{{
                    output.modelName || "-"
                  }}</span>
                </td>
                <td class="px-4 py-3 whitespace-nowrap text-gray-500">
                  {{ output.type }}
                </td>
                <td class="px-4 py-3 whitespace-nowrap text-gray-500">
                  {{ output.methodName }}
                </td>
                <td class="px-4 py-3 whitespace-nowrap">
                  <span
                    :class="[
                      'px-2 py-1 rounded-full text-xs font-medium',
                      getStatusColor(output.status),
                    ]"
                  >
                    {{ output.status }}
                  </span>
                </td>
                <td class="px-4 py-3 whitespace-nowrap text-gray-500">
                  {{ formatDate(output.startedAt) }}
                </td>
                <td class="px-4 py-3 whitespace-nowrap text-gray-500">
                  {{ formatDuration(output.durationMs) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Empty State -->
      <div
        v-if="workflowRuns.length === 0 && outputs.length === 0"
        class="bg-white rounded-lg shadow p-8 text-center text-gray-500"
      >
        No outputs found. Run a workflow or model method to see results here.
      </div>
    </div>
  </div>
</template>
