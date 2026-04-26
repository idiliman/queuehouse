/**
 * Collapses dynamic path segments so Prometheus labels stay bounded.
 */
export function httpRouteTemplate(pathname: string): string {
  const path = (pathname.split("?")[0] ?? pathname).replace(/\/+$/, "") || "/";

  const rules: [RegExp, string][] = [
    [
      /^\/api\/v1\/jobs\/[^/]+\/[^/]+\/raw-reveal$/,
      "/api/v1/jobs/:queueName/:jobId/raw-reveal",
    ],
    [
      /^\/api\/v1\/jobs\/[^/]+\/[^/]+\/retry-as-new$/,
      "/api/v1/jobs/:queueName/:jobId/retry-as-new",
    ],
    [/^\/api\/v1\/jobs\/[^/]+\/[^/]+\/retry$/, "/api/v1/jobs/:queueName/:jobId/retry"],
    [/^\/api\/v1\/jobs\/[^/]+\/[^/]+$/, "/api/v1/jobs/:queueName/:jobId"],
    [/^\/api\/v1\/queues\/[^/]+\/pause$/, "/api/v1/queues/:queueName/pause"],
    [/^\/api\/v1\/queues\/[^/]+\/resume$/, "/api/v1/queues/:queueName/resume"],
    [/^\/api\/v1\/schedules\/[^/]+$/, "/api/v1/schedules/:id"],
    [/^\/api\/v1\/api-keys\/[^/]+$/, "/api/v1/api-keys/:id"],
  ];

  for (const [re, tmpl] of rules) {
    if (re.test(path)) return tmpl;
  }
  return path;
}

export function httpStatusClass(status: number): "2xx" | "3xx" | "4xx" | "5xx" | "other" {
  if (status >= 200 && status <= 299) return "2xx";
  if (status >= 300 && status <= 399) return "3xx";
  if (status >= 400 && status <= 499) return "4xx";
  if (status >= 500 && status <= 599) return "5xx";
  return "other";
}
