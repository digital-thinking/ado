/**
 * Utility for strictly extracting and parsing JSON from model outputs.
 * Handles direct JSON, markdown-fenced JSON, and raw object extraction.
 */

/**
 * Finds the first JSON object in a string by tracking brace depth.
 * Robust against strings containing braces.
 */
export function extractFirstJsonObject(raw: string): string | null {
  const startIndex = raw.indexOf("{");
  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

/**
 * Parses JSON from model output with multiple fallback strategies.
 * 1. Direct parse of trimmed output.
 * 2. Markdown-fenced JSON block.
 * 3. Extraction of first JSON object via brace depth.
 */
export function parseJsonFromModelOutput<T = unknown>(
  rawOutput: string,
  errorMessage = "Model output is not valid JSON.",
): T {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    throw new Error(errorMessage.replace("not valid JSON", "empty"));
  }

  // 1. Direct try
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Continue
  }

  // 2. Fenced block try
  const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawOutput);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1].trim()) as T;
    } catch {
      // Continue
    }
  }

  // 3. Brace depth extraction try
  const objectPayload = extractFirstJsonObject(rawOutput);
  if (objectPayload) {
    try {
      return JSON.parse(objectPayload) as T;
    } catch {
      // Continue
    }
  }

  throw new Error(errorMessage);
}
