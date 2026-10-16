/**
 * Reads dashboard runtime configuration from Vite environment variables
 * (`VITE_TKL_API_BASE_URL`, `VITE_TKL_API_TOKEN`, `VITE_TKL_PRODUCT_ID`).
 *
 * The dashboard never stores source-system credentials; `VITE_TKL_API_TOKEN` is only a
 * bearer token for the TKL Application API itself (see `apps/api` authentication), and it
 * is baked into the client bundle like any other public SPA config — do not put long-lived
 * secrets here in production; use a short-lived session token issued by the identity
 * provider instead.
 */
export interface DashboardApiConfig {
  baseUrl: string | undefined;
  token: string | undefined;
  productId: string;
  allowMockData: boolean;
}

export function getDashboardApiConfig(): DashboardApiConfig {
  const env = import.meta.env;
  return {
    baseUrl: env.VITE_TKL_API_BASE_URL as string | undefined,
    token: env.VITE_TKL_API_TOKEN as string | undefined,
    productId: (env.VITE_TKL_PRODUCT_ID as string | undefined) ?? "fl-titling",
    allowMockData:
      env.DEV
      || env.MODE === "test"
      || env.VITE_TKL_DEMO_MODE === "true",
  };
}
