import "./test-setup";
import { describe, expect, it } from "bun:test";
import { getOpenApiDocumentForTests } from "../src/openapi/api-docs";

type Oas = {
  paths?: Record<string, { post?: { deprecated?: boolean; operationId?: string } }>;
};

describe("OpenAPI from job registry (contract)", () => {
  it("exposes per-job POST paths for jobs with enqueue.api only", () => {
    const doc = getOpenApiDocumentForTests() as Oas;
    const paths = Object.keys(doc.paths ?? {});
    expect(paths).toContain("/jobs/example.success/enqueue");
    expect(paths).toContain("/jobs/example.deprecated/enqueue");
    expect(paths).toContain("/jobs/example.dlq/enqueue");
    expect(paths).toContain("/jobs/example.fail/enqueue");
    expect(paths).not.toContain("/jobs/example.progress/enqueue");
  });

  it("marks deprecated public jobs in the operation", () => {
    const doc = getOpenApiDocumentForTests() as Oas;
    const dep = doc.paths?.["/jobs/example.deprecated/enqueue"]?.post;
    expect(dep?.deprecated).toBe(true);
    const current = doc.paths?.["/jobs/example.success/enqueue"]?.post;
    expect(current?.deprecated).not.toBe(true);
  });

  it("documents a generic enqueue path for tooling", () => {
    const doc = getOpenApiDocumentForTests() as Oas;
    const gen = doc.paths?.["/jobs/enqueue"]?.post;
    expect(gen?.operationId).toBe("enqueue_generic");
  });
});
