import { z } from "zod";

export const CLIAdapterIdSchema = z.enum([
  "MOCK_CLI",
  "CLAUDE_CLI",
  "GEMINI_CLI",
  "CODEX_CLI",
]);
export type CLIAdapterId = z.infer<typeof CLIAdapterIdSchema>;
export const CLI_ADAPTER_IDS: CLIAdapterId[] = [
  "CODEX_CLI",
  "CLAUDE_CLI",
  "GEMINI_CLI",
  "MOCK_CLI",
];
