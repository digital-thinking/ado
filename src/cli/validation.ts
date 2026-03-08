/**
 * Centralized validation-error type for CLI argument validation.
 *
 * All user-facing argument validation failures should throw a `ValidationError`
 * so the global error handler can format them consistently and distinguish them
 * from unexpected runtime errors.
 *
 * Output format (printed to stderr):
 *   Error: <message>
 *     Usage: <usage>        (when usage is provided)
 *     Hint:  <hint>         (when hint is provided)
 */
export class ValidationError extends Error {
  readonly usage?: string;
  readonly hint?: string;

  constructor(message: string, opts?: { usage?: string; hint?: string }) {
    super(message);
    this.name = "ValidationError";
    this.usage = opts?.usage;
    this.hint = opts?.hint;
  }

  /** Returns a consistently formatted multi-line string for stderr output. */
  format(): string {
    const lines: string[] = [`Error: ${this.message}`];
    if (this.usage) lines.push(`  Usage: ${this.usage}`);
    if (this.hint) lines.push(`  Hint:  ${this.hint}`);
    return lines.join("\n");
  }
}
