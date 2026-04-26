import { loadConfig } from "@queuehouse/core";

/** Validated on module load; tests must set env before importing the server. */
export const config = loadConfig(process.env);
