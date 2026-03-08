import { describe, expect, test } from "bun:test";
import { ProjectRecordSchema } from "../types";

describe("P12-011: ProjectRecord schema", () => {
  test("ProjectRecordSchema validates executionSettings", () => {
    const valid = {
      name: "test",
      rootDir: "/tmp/test",
      executionSettings: {
        autoMode: true,
        defaultAssignee: "CODEX_CLI",
      },
    };
    expect(ProjectRecordSchema.parse(valid)).toEqual(valid as any);
  });
});
