import { createRouter, createWebHistory } from "vue-router";
import DashboardView from "../views/DashboardView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "dashboard",
      component: DashboardView,
    },
    {
      path: "/models",
      name: "models",
      component: () => import("../views/models/ModelListView.vue"),
    },
    {
      path: "/models/:type/:id",
      name: "model-detail",
      component: () => import("../views/models/ModelDetailView.vue"),
    },
    {
      path: "/models/:type/:id/edit",
      name: "model-edit",
      component: () => import("../views/models/ModelEditView.vue"),
    },
    {
      path: "/models/new/:type?",
      name: "model-new",
      component: () => import("../views/models/ModelEditView.vue"),
    },
    {
      path: "/workflows",
      name: "workflows",
      component: () => import("../views/workflows/WorkflowListView.vue"),
    },
    {
      path: "/workflows/:id",
      name: "workflow-detail",
      component: () => import("../views/workflows/WorkflowDetailView.vue"),
    },
    {
      path: "/workflows/:id/edit",
      name: "workflow-edit",
      component: () => import("../views/workflows/WorkflowEditView.vue"),
    },
    {
      path: "/workflows/new",
      name: "workflow-new",
      component: () => import("../views/workflows/WorkflowEditView.vue"),
    },
  ],
});

export default router;
