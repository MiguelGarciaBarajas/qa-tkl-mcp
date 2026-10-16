import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";

/**
 * INT-102 end-to-end process harness.
 *
 * Starts a fixture-seeded TKL Application API (`tests/e2e/harness/api-server.mjs`) and a
 * real Vite dashboard server, both on collision-safe ports reserved from the OS, wires a
 * per-run random development bearer token through both, and tears everything down
 * deterministically. Nothing here contacts an external system, weakens API
 * authentication, or exposes fixture ingestion over HTTP.
 *
 * The dashboard reaches the API through the Vite dev server's proxy (`/v1`, `/health`)
 * so the browser stays same-origin: the production API does not need - and does not get -
 * a permissive CORS policy just to make a test pass.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DASHBOARD_ROOT = path.join(REPO_ROOT, "apps", "dashboard");
const API_HARNESS_ENTRY = path.join(REPO_ROOT, "tests", "e2e", "harness", "api-server.mjs");
const TMP_ROOT = path.join(REPO_ROOT, "tests", "e2e", ".tmp");

export const E2E_PRODUCT_ID = "fl-titling";
export const E2E_TENANT_ID = "solera";
export const E2E_SUBJECT = "e2e-reviewer";

export interface ApiHarness {
  url: string;
  token: string;
  ingestedRecords: number;
  stop: () => Promise<void>;
}

export interface DashboardHarness {
  url: string;
  stop: () => Promise<void>;
}

/** Reserves a free loopback port from the OS and releases it for the child to bind. */
export async function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error("Could not reserve an ephemeral port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Development-only bearer token, random per run, never written to a committed file and
 * never reused across runs. The matching auth context grants exactly the permissions the
 * stakeholder flow needs on exactly one product, so authorization stays observable.
 */
function createDevelopmentToken() {
  const token = `e2e-${randomBytes(24).toString("hex")}`;
  const authTokens = {
    [token]: {
      subject: E2E_SUBJECT,
      tenantId: E2E_TENANT_ID,
      roles: ["reviewer"],
      permissions: [
        "knowledge:read",
        "ask:read",
        "coverage:read",
        "traceability:read",
        "conflicts:read",
        "conflicts:review",
        "connections:read",
        "connections:write",
        "connections:sync",
        "actions:testrail-case-create",
      ],
      productIds: [E2E_PRODUCT_ID],
    },
  };
  return { token, authTokens: JSON.stringify(authTokens) };
}

type HarnessProcess = ChildProcessByStdio<null, Readable, Readable>;

async function stopProcess(child: HarnessProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}
/** Starts the fixture-seeded Application API and resolves once it reports readiness. */
export async function startApiServer(): Promise<ApiHarness> {
  const port = await reservePort();
  const { token, authTokens } = createDevelopmentToken();

  const child: HarnessProcess = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", API_HARNESS_ENTRY],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        TKL_TENANT_ID: E2E_TENANT_ID,
        TKL_PRODUCT_ID: E2E_PRODUCT_ID,
        TKL_AUTH_TOKENS: authTokens,
        TKL_AUDIT_DESTINATION: "none",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  let ready: { url: string; ingestedRecords: number };
  try {
    ready = await new Promise<{ url: string; ingestedRecords: number }>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      const settle = (outcome: () => void) => {
        clearTimeout(timer);
        lines.close();
        outcome();
      };
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(new Error(`Timed out starting the harness API.\n${stderr.join("")}`)),
          ),
        60_000,
      );
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line) as {
            ready?: boolean;
            url?: string;
            ingestedRecords?: number;
          };
          if (message.ready && message.url) {
            settle(() =>
              resolve({ url: message.url as string, ingestedRecords: message.ingestedRecords ?? 0 }),
            );
          }
        } catch {
          // Ignore non-JSON diagnostics.
        }
      });
      child.once("exit", (code) => {
        settle(() =>
          reject(new Error(`Harness API exited early with code ${code}.\n${stderr.join("")}`)),
        );
      });
    });
  } catch (error) {
    // A startup timeout must not leak the child: without this the process would keep the
    // reserved port - and a CI runner slot - until the whole job is torn down.
    await stopProcess(child);
    throw error;
  }

  return {
    url: ready.url,
    token,
    ingestedRecords: ready.ingestedRecords,
    stop: () => stopProcess(child),
  };
}

export interface DashboardOptions {
  apiUrl: string;
  /** Bearer token baked into the dashboard bundle, exactly as a deployment would. */
  token: string;
  productId?: string;
}

/**
 * Starts the real dashboard (Vite) against the harness API. Runtime configuration is
 * written to a per-instance temporary `.env` directory instead of mutating the shared
 * process environment, so several dashboard instances - for example a valid-token and an
 * invalid-token one - can run side by side deterministically.
 */
export async function startDashboardServer(options: DashboardOptions): Promise<DashboardHarness> {
  const port = await reservePort();
  const envDir = path.join(TMP_ROOT, `dashboard-${randomUUID()}`);
  const origin = `http://127.0.0.1:${port}`;

  mkdirSync(envDir, { recursive: true });
  writeFileSync(
    path.join(envDir, ".env"),
    [
      `VITE_TKL_API_BASE_URL=${origin}`,
      `VITE_TKL_API_TOKEN=${options.token}`,
      `VITE_TKL_PRODUCT_ID=${options.productId ?? E2E_PRODUCT_ID}`,
      "",
    ].join("\n"),
    "utf8",
  );

  let server: ViteDevServer;
  try {
    server = await createViteServer({
      configFile: path.join(DASHBOARD_ROOT, "vite.config.ts"),
      root: DASHBOARD_ROOT,
      envDir,
      logLevel: "warn",
      server: {
        host: "127.0.0.1",
        port,
        strictPort: true,
        proxy: {
          "/v1": { target: options.apiUrl, changeOrigin: false },
          "/health": { target: options.apiUrl, changeOrigin: false },
        },
      },
    });
    await server.listen();
  } catch (error) {
    rmSync(envDir, { recursive: true, force: true });
    throw error;
  }

  return {
    url: origin,
    stop: async () => {
      await server.close();
      rmSync(envDir, { recursive: true, force: true });
    },
  };
}
