import type { SessionUser } from "./auth/session";

export type ApiVariables = {
  requestId: string;
  user?: SessionUser;
};
