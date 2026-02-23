import { describe, expect, test } from "bun:test";

import { generateCompletionScript, parseCompletionShell } from "./completion";

describe("completion scripts", () => {
  test("parses supported shells", () => {
    expect(parseCompletionShell("bash")).toBe("bash");
    expect(parseCompletionShell("zsh")).toBe("zsh");
    expect(parseCompletionShell("fish")).toBe("fish");
    expect(parseCompletionShell(" BASH ")).toBe("bash");
  });

  test("rejects unsupported shell", () => {
    expect(() => parseCompletionShell(undefined)).toThrow(
      "Usage: ixado completion <bash|zsh|fish>",
    );
    expect(() => parseCompletionShell("pwsh")).toThrow(
      "Usage: ixado completion <bash|zsh|fish>",
    );
  });

  test("generates bash completion with key commands", () => {
    const script = generateCompletionScript("bash");
    expect(script).toContain("_ixado_completion()");
    expect(script).toContain("complete -F _ixado_completion ixado");
    expect(script).toContain("completion");
    expect(script).toContain("bash zsh fish");
  });

  test("generates zsh completion with key commands", () => {
    const script = generateCompletionScript("zsh");
    expect(script).toContain("#compdef ixado");
    expect(script).toContain("completion:Generate shell completion script");
    expect(script).toContain("_values 'shell' bash zsh fish");
  });

  test("generates fish completion with key commands", () => {
    const script = generateCompletionScript("fish");
    expect(script).toContain(
      "complete -c ixado -n '__fish_use_subcommand' -a 'completion'",
    );
    expect(script).toContain("__fish_seen_subcommand_from completion");
    expect(script).toContain("-a 'bash'");
    expect(script).toContain("-a 'zsh'");
    expect(script).toContain("-a 'fish'");
  });
});
