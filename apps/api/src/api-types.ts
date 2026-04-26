import type { SessionUser } from "./auth/session";

export type ApiKeyContext = {
  id: string;
  scopes: string[];
  allowedJobTypes: string[];
};

export type ApiVariables = {
  requestId: string;
  user?: SessionUser;
  /** Set when the request used `Authorization: Bearer qh_…` (not cookie sessions). */
  apiKey?: ApiKeyContext;
};
