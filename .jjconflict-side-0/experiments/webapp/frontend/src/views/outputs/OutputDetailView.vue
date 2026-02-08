<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useRoute } from "vue-router";
import {
  getOutput,
  getOutputData,
  getOutputLogs,
  type Output,
  type OutputDataResponse,
  type OutputLogsResponse,
} from "../../api/client";

const route = useRoute();
const output = ref<Output | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const activeTab = ref<"info" | "logs">("info");

// Data for Info tab (auto-loaded)
const dataResponse = ref<OutputDataResponse | null>(null);

// Logs tab state
const logsResponse = ref<OutputLogsResponse | null>(null);
const logsLoading = ref(false);
const logsError = ref<string | null>(null);
const tailLines = ref<number | undefined>(undefined);
const tailInput = ref("");

const idParam = route.params.id as string;

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

// Strip ANSI escape codes from log lines
// Matches: CSI sequences, OSC sequences, and other escape sequences
const ansiRegex = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[?\d;]*[hl]|\x1b[PX^_].*?\x1b\\|\x1b\[[\d;]*m/g;

function stripAnsi(str: string): string {
  return str.replace(ansiRegex, "");
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

const hasLogArtifacts = computed(
  () => output.value?.artifacts?.logIds && output.value.artifacts.logIds.length > 0
);

// Extract execution data fields with type safety
interface ExecutionData {
  command?: string;
  exitCode?: number;
  timestamp?: string;
  durationMs?: number;
}

const executionData = computed((): ExecutionData | null => {
  const data = dataResponse.value?.data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const result: ExecutionData = {
    command: typeof d.command === "string" ? d.command : undefined,
    exitCode: typeof d.exitCode === "number" ? d.exitCode : undefined,
    timestamp: typeof d.timestamp === "string" ? d.timestamp : undefined,
    durationMs: typeof d.durationMs === "number" ? d.durationMs : undefined,
  };
  // Only return if at least one field has data
  if (
    result.command === undefined &&
    result.exitCode === undefined &&
    result.timestamp === undefined &&
    result.durationMs === undefined
  ) {
    return null;
  }
  return result;
});

// Strip ANSI codes from log lines for display
const cleanedLogLines = computed(() => {
  if (!logsResponse.value) return [];
  return logsResponse.value.lines.map(stripAnsi);
});

onMounted(async () => {
  try {
    output.value = await getOutput(idParam);
    // Auto-load data if available
    if (output.value?.artifacts?.dataId) {
      try {
        dataResponse.value = await getOutputData(output.value.id);
      } catch {
        // Silently ignore data load errors - section just won't show
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load output";
  } finally {
    loading.value = false;
  }
});

async function loadLogs() {
  if (!output.value) return;
  logsLoading.value = true;
  logsError.value = null;
  try {
    const tail = tailInput.value ? parseInt(tailInput.value, 10) : undefined;
    logsResponse.value = await getOutputLogs(output.value.id, tail);
    tailLines.value = tail;
  } catch (e) {
    logsError.value = e instanceof Error ? e.message : "Failed to load logs";
  } finally {
    logsLoading.value = false;
  }
}

function handleTabChange(tab: "info" | "logs") {
  activeTab.value = tab;
  if (tab === "logs" && !logsResponse.value && hasLogArtifacts.value) {
    loadLogs();
  }
}
</script>

<template>
  <div>
    <div class="mb-6">
      <RouterLink
        to="/outputs"
        class="text-blue-600 hover:text-blue-800 text-sm"
      >
        &larr; Back to Outputs
      </RouterLink>
    </div>

    <div
      v-if="error"
      class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6"
    >
      {{ error }}
    </div>

    <div v-if="loading" class="text-gray-500">Loading...</div>

    <div v-else-if="output" class="bg-white rounded-lg shadow">
      <div class="px-6 py-4 border-b border-gray-200">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-2xl font-bold text-gray-900">
              {{ output.modelName || "Unknown Model" }}
            </h1>
            <p class="text-sm text-gray-500 mt-1">
              {{ output.methodName }} - {{ output.type }}
            </p>
          </div>
          <span
            :class="[
              'px-3 py-1 rounded-full text-sm font-medium',
              getStatusColor(output.status),
            ]"
          >
            {{ output.status }}
          </span>
        </div>
      </div>

      <!-- Tabs -->
      <div class="border-b border-gray-200">
        <nav class="flex -mb-px">
          <button
            @click="handleTabChange('info')"
            :class="[
              'px-6 py-3 border-b-2 font-medium text-sm',
              activeTab === 'info'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
            ]"
          >
            Info
          </button>
          <button
            @click="handleTabChange('logs')"
            :class="[
              'px-6 py-3 border-b-2 font-medium text-sm',
              activeTab === 'logs'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
            ]"
          >
            Logs
          </button>
        </nav>
      </div>

      <!-- Tab Content -->
      <div class="p-6">
        <!-- Info Tab -->
        <div v-if="activeTab === 'info'" class="space-y-6">
          <div class="grid grid-cols-2 gap-6">
            <div>
              <div class="text-sm font-medium text-gray-500">Output ID</div>
              <div class="mt-1 text-sm text-gray-900 font-mono">
                {{ output.id }}
              </div>
            </div>
            <div>
              <div class="text-sm font-medium text-gray-500">Model Input ID</div>
              <div class="mt-1 text-sm text-gray-900 font-mono">
                {{ output.modelInputId }}
              </div>
            </div>
            <div>
              <div class="text-sm font-medium text-gray-500">Type</div>
              <div class="mt-1 text-sm text-gray-900">{{ output.type }}</div>
            </div>
            <div>
              <div class="text-sm font-medium text-gray-500">Method</div>
              <div class="mt-1 text-sm text-gray-900">{{ output.methodName }}</div>
            </div>
            <div>
              <div class="text-sm font-medium text-gray-500">Started At</div>
              <div class="mt-1 text-sm text-gray-900">
                {{ formatDate(output.startedAt) }}
              </div>
            </div>
            <div>
              <div class="text-sm font-medium text-gray-500">Completed At</div>
              <div class="mt-1 text-sm text-gray-900">
                {{ formatDate(output.completedAt) }}
              </div>
            </div>
            <div>
              <div class="text-sm font-medium text-gray-500">Duration</div>
              <div class="mt-1 text-sm text-gray-900">
                {{ formatDuration(output.durationMs) }}
              </div>
            </div>
            <div>
              <div class="text-sm font-medium text-gray-500">Retry Count</div>
              <div class="mt-1 text-sm text-gray-900">{{ output.retryCount }}</div>
            </div>
          </div>

          <!-- Provenance -->
          <div>
            <div class="text-sm font-medium text-gray-500 mb-2">Provenance</div>
            <div class="bg-gray-50 p-4 rounded">
              <div class="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span class="text-gray-500">Triggered By:</span>
                  <span class="ml-2 text-gray-900">{{ output.provenance.triggeredBy }}</span>
                </div>
                <div>
                  <span class="text-gray-500">Model Version:</span>
                  <span class="ml-2 text-gray-900">{{ output.provenance.modelVersion }}</span>
                </div>
                <div v-if="output.provenance.workflowId">
                  <span class="text-gray-500">Workflow ID:</span>
                  <span class="ml-2 text-gray-900 font-mono">{{ output.provenance.workflowId }}</span>
                </div>
                <div v-if="output.provenance.workflowRunId">
                  <span class="text-gray-500">Workflow Run ID:</span>
                  <span class="ml-2 text-gray-900 font-mono">{{ output.provenance.workflowRunId }}</span>
                </div>
                <div v-if="output.provenance.stepName">
                  <span class="text-gray-500">Step Name:</span>
                  <span class="ml-2 text-gray-900">{{ output.provenance.stepName }}</span>
                </div>
                <div class="col-span-2">
                  <span class="text-gray-500">Input Hash:</span>
                  <span class="ml-2 text-gray-900 font-mono text-xs">{{ output.provenance.inputHash }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Artifacts -->
          <div v-if="output.artifacts">
            <div class="text-sm font-medium text-gray-500 mb-2">Artifacts</div>
            <div class="bg-gray-50 p-4 rounded">
              <div class="grid grid-cols-2 gap-4 text-sm">
                <div v-if="output.artifacts.dataId">
                  <span class="text-gray-500">Data ID:</span>
                  <span class="ml-2 text-gray-900 font-mono">{{ output.artifacts.dataId }}</span>
                </div>
                <div v-if="output.artifacts.resourceId">
                  <span class="text-gray-500">Resource ID:</span>
                  <span class="ml-2 text-gray-900 font-mono">{{ output.artifacts.resourceId }}</span>
                </div>
                <div v-if="output.artifacts.fileId">
                  <span class="text-gray-500">File ID:</span>
                  <span class="ml-2 text-gray-900 font-mono">{{ output.artifacts.fileId }}</span>
                </div>
                <div v-if="output.artifacts.logIds && output.artifacts.logIds.length > 0">
                  <span class="text-gray-500">Log IDs:</span>
                  <div class="ml-2">
                    <span
                      v-for="logId in output.artifacts.logIds"
                      :key="logId"
                      class="block text-gray-900 font-mono text-xs"
                    >
                      {{ logId }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Execution Data -->
          <div v-if="executionData">
            <div class="text-sm font-medium text-gray-500 mb-2">Execution Data</div>
            <div class="bg-gray-50 p-4 rounded">
              <div class="grid grid-cols-2 gap-4 text-sm">
                <div v-if="executionData.command" class="col-span-2">
                  <span class="text-gray-500">Command:</span>
                  <code class="ml-2 text-gray-900 bg-gray-100 px-2 py-1 rounded">{{ executionData.command }}</code>
                </div>
                <div v-if="executionData.exitCode !== undefined">
                  <span class="text-gray-500">Exit Code:</span>
                  <span
                    :class="[
                      'ml-2 font-mono',
                      executionData.exitCode === 0 ? 'text-green-600' : 'text-red-600'
                    ]"
                  >{{ executionData.exitCode }}</span>
                </div>
                <div v-if="executionData.timestamp">
                  <span class="text-gray-500">Executed At:</span>
                  <span class="ml-2 text-gray-900">{{ formatDate(executionData.timestamp) }}</span>
                </div>
                <div v-if="executionData.durationMs !== undefined">
                  <span class="text-gray-500">Duration:</span>
                  <span class="ml-2 text-gray-900">{{ formatDuration(executionData.durationMs) }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Error -->
          <div v-if="output.error">
            <div class="text-sm font-medium text-red-500 mb-2">Error</div>
            <div class="bg-red-50 p-4 rounded border border-red-200">
              <div class="text-sm text-red-700 font-medium">
                {{ output.error.message }}
              </div>
              <pre
                v-if="output.error.stack"
                class="mt-2 text-xs text-red-600 overflow-auto"
              >{{ output.error.stack }}</pre>
            </div>
          </div>
        </div>

        <!-- Logs Tab -->
        <div v-else-if="activeTab === 'logs'">
          <!-- No logs available message -->
          <div v-if="!hasLogArtifacts" class="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
            <div class="text-gray-400 text-4xl mb-3">📋</div>
            <div class="text-gray-600 font-medium mb-1">No logs available</div>
            <div class="text-sm text-gray-500">
              This execution did not produce any log output.
              <br />
              Logs are typically generated by methods that perform streaming operations or verbose processing.
            </div>
          </div>

          <!-- Logs available -->
          <div v-else>
            <div class="mb-4 flex items-center gap-4">
              <div class="flex items-center gap-2">
                <label class="text-sm text-gray-600">Tail lines:</label>
                <input
                  v-model="tailInput"
                  type="number"
                  min="1"
                  placeholder="All"
                  class="w-24 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                @click="loadLogs"
                :disabled="logsLoading"
                class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {{ logsLoading ? "Loading..." : "Fetch" }}
              </button>
            </div>

            <div
              v-if="logsError"
              class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4"
            >
              {{ logsError }}
            </div>

            <div v-if="logsLoading" class="text-gray-500">Loading logs...</div>

            <div v-else-if="logsResponse">
              <div class="mb-2 text-sm text-gray-500">
                Showing {{ logsResponse.showingLines }} of {{ logsResponse.totalLines }} lines
              </div>
              <div class="bg-gray-900 text-gray-100 p-4 rounded font-mono text-sm overflow-auto max-h-96">
                <div
                  v-for="(line, index) in cleanedLogLines"
                  :key="index"
                  class="whitespace-pre-wrap"
                >{{ line }}</div>
                <div v-if="cleanedLogLines.length === 0" class="text-gray-500">
                  No log entries
                </div>
              </div>
            </div>

            <div v-else class="text-gray-500">
              Click "Fetch" to load log entries
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
