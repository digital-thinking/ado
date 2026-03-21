import type { ProcessRunner } from "../process";
import type { VcsProviderType } from "../types";
import { GitHubProvider } from "./github-provider";
import { LocalProvider } from "./local-provider";
import { NullProvider } from "./null-provider";
import type { VcsProvider } from "./vcs-provider";

export function createVcsProvider(
  type: VcsProviderType,
  runner: ProcessRunner,
): VcsProvider {
  switch (type) {
    case "github":
      return new GitHubProvider(runner);
    case "local":
      return new LocalProvider(runner);
    case "null":
      return new NullProvider();
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown VCS provider type: ${_exhaustive}`);
    }
  }
}
