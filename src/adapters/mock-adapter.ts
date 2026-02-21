import type { ProcessRunner } from "../process";

import { BaseCliAdapter } from "./types";

type MockAdapterOptions = {
  command?: string;
  baseArgs?: string[];
};

export class MockCLIAdapter extends BaseCliAdapter {
  constructor(runner: ProcessRunner, options: MockAdapterOptions = {}) {
    super({
      id: "MOCK_CLI",
      command: options.command ?? "mock-cli",
      baseArgs: options.baseArgs ?? ["run"],
      runner,
    });
  }
}
