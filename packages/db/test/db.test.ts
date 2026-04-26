import { describe, expect, it } from "bun:test";
import { prisma } from "../src/index";

describe("@queuehouse/db", () => {
  it("exports a Prisma client instance", () => {
    expect(prisma).toBeDefined();
  });
});
