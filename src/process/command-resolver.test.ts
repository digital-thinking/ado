import { describe, expect, test } from "bun:test";

import { resolveCommandForSpawn } from "./command-resolver";

describe("resolveCommandForSpawn", () => {
  test("keeps command unchanged on non-windows", () => {
    expect(resolveCommandForSpawn("codex", {}, "linux", () => false)).toBe("codex");
  });

  test("resolves windows command via PATH/PATHEXT", () => {
    const expected = "c:\\bin\\codex.cmd";
    const resolved = resolveCommandForSpawn(
      "codex",
      {
        Path: "C:\\tools;C:\\bin",
        PATHEXT: ".EXE;.CMD",
      },
      "win32",
      (candidate) => candidate.replace(/\//g, "\\").toLowerCase() === expected
    );

    expect(resolved.replace(/\//g, "\\").toLowerCase()).toBe(expected);
  });

  test("keeps explicit extension command on windows", () => {
    const resolved = resolveCommandForSpawn(
      "codex.cmd",
      {
        Path: "C:\\tools",
      },
      "win32",
      () => false
    );
    expect(resolved).toBe("codex.cmd");
  });
});
