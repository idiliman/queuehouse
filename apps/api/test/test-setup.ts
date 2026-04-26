import { EXAMPLE_DATABASE_URL } from "@queuehouse/core";

process.env.DATABASE_URL = EXAMPLE_DATABASE_URL;
process.env.REDIS_URL = "redis://localhost:6379";
