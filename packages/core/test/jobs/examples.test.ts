import { describe, expect, it, beforeEach } from "bun:test";
import {
  clearJobRegistryForTests,
  exampleFailJob,
  exampleProgressJob,
  exampleSuccessJob,
  registerExampleJobs,
  runExampleJobSync,
} from "../../src/jobs";

beforeEach(() => {
  clearJobRegistryForTests();
  registerExampleJobs();
});

describe("example jobs", () => {
  it("example.success completes with validated output", () => {
    const out = runExampleJobSync(exampleSuccessJob, { message: "hi" }) as {
      echoed: string;
    };
    expect(out.echoed).toBe("hi");
    expect(() => runExampleJobSync(exampleSuccessJob, { message: "" })).toThrow();
  });

  it("example.progress returns log lines", () => {
    const out = runExampleJobSync(exampleProgressJob, { steps: 3 }) as {
      completed: number;
      log: string[];
    };
    expect(out.completed).toBe(3);
    expect(out.log).toEqual(["step 1/3", "step 2/3", "step 3/3"]);
  });

  it("example.fail throws after validating input", () => {
    expect(() => runExampleJobSync(exampleFailJob, {})).toThrow(/intentional failure/);
    expect(() => runExampleJobSync(exampleFailJob, { errorMessage: "boom" })).toThrow(/boom/);
  });
});
