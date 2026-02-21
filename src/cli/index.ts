const REQUIRED_ENV_VARS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID"] as const;

function getRequiredEnv(name: (typeof REQUIRED_ENV_VARS)[number]): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseOwnerId(rawOwnerId: string): number {
  const ownerId = Number(rawOwnerId);

  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    throw new Error("TELEGRAM_OWNER_ID must be a positive integer.");
  }

  return ownerId;
}

function bootstrap(): void {
  const token = getRequiredEnv("TELEGRAM_BOT_TOKEN");
  const ownerId = parseOwnerId(getRequiredEnv("TELEGRAM_OWNER_ID"));

  console.info("IxADO bootstrap checks passed.");
  console.info(
    `Telegram security preconditions verified (owner: ${ownerId}, token length: ${token.length}).`
  );
  console.info("Core engine and Telegram adapter wiring are pending in ROADMAP phases.");
}

try {
  bootstrap();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Startup failed: ${message}`);
  process.exitCode = 1;
}
