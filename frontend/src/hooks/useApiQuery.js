/**
 * Thin adapter over @tanstack/react-query that wires our `api.get(...)`
 * helper straight in. Kept intentionally minimal — we don't want a
 * heavy abstraction over React Query; we just want the ergonomic
 * `useApiQuery('/reports/x', {params})` shape that reads like the
 * `useEffect + api.get` blocks it replaces.
 *
 * Why: 20 Feb 2026 perf pass — React Query was installed months ago
 * but never adopted. Pages were doing raw `useEffect` fetches on every
 * mount → no cache, no dedup, no stale-while-revalidate. Migrating the
 * hot pages (Grid, Dashboard, Approvals, ChurnRisk) makes tab-switch
 * feel instant.
 *
 * Conventions:
 *   • Key is `[path, params]` — stable across identity-equal objects.
 *   • Errors bubble as ApiError (see api.js), so callers can use
 *     `showApiError(query.error, "…")` on top of the return.
 *   • Callers still get `.refetch()` for the "Run" / "Refresh" buttons.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/** Fetch a JSON endpoint with the request scoped to the auth axios client.
 *
 * @param {string} path        API path (e.g. `/reports/churn-risk`)
 * @param {object} [params]    querystring params
 * @param {object} [options]   extra `useQuery` options — commonly
 *                             { enabled, staleTime, refetchInterval }
 */
export function useApiQuery(path, params, options) {
  return useQuery({
    queryKey: [path, params || null],
    queryFn: () => api.get(path, params),
    ...options,
  });
}
