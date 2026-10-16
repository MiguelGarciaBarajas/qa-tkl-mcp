import { test as base } from "@playwright/test";
import {
  startApiServer,
  startDashboardServer,
  type ApiHarness,
  type DashboardHarness,
} from "./servers";

/**
 * Worker-scoped fixtures for the INT-102 browser slice.
 *
 * `stack` starts one fixture-seeded API plus one dashboard for the whole worker, so the
 * conflict review performed in one test is observable as persisted state in later
 * navigations. Teardown runs even when a test fails, so no process or temporary
 * directory survives the run.
 */
export interface TklStack {
  api: ApiHarness;
  dashboard: DashboardHarness;
}

export const test = base.extend<
  { unauthorizedDashboard: DashboardHarness },
  { stack: TklStack }
>({
  stack: [
    async ({}, use) => {
      const api = await startApiServer();
      let dashboard: DashboardHarness;
      try {
        dashboard = await startDashboardServer({ apiUrl: api.url, token: api.token });
      } catch (error) {
        // The API is already running at this point; without this the worker would leak a
        // listening process for every failed dashboard start.
        await api.stop();
        throw error;
      }
      try {
        await use({ api, dashboard });
      } finally {
        // Nested so a failing dashboard shutdown can never leave the API process alive.
        try {
          await dashboard.stop();
        } finally {
          await api.stop();
        }
      }
    },
    { scope: "worker" },
  ],

  /** A second dashboard instance configured with a token the API will reject. */
  unauthorizedDashboard: async ({ stack }, use) => {
    const dashboard = await startDashboardServer({
      apiUrl: stack.api.url,
      token: "invalid-e2e-token",
    });
    try {
      await use(dashboard);
    } finally {
      await dashboard.stop();
    }
  },

  baseURL: async ({ stack }, use) => {
    await use(stack.dashboard.url);
  },
});

export const expect = test.expect;
