import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export type TodoFixmeTag = "TODO" | "FIXME";

export type TodoFixmePriorityWeights = {
  recency: number;
  frequency: number;
  tags: number;
};

export type TodoFixmeTagWeights = Record<TodoFixmeTag, number>;

export type TodoFixmeScannerOptions = {
  rootDir: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  priorityWeights?: Partial<TodoFixmePriorityWeights>;
  tagWeights?: Partial<TodoFixmeTagWeights>;
  maxFileSizeBytes?: number;
};

export type TodoFixmeFinding = {
  tag: TodoFixmeTag;
  text: string;
  filePath: string;
  line: number;
  lineText: string;
  frequency: number;
  recencyScore: number;
  frequencyScore: number;
  tagScore: number;
  priorityScore: number;
};

const DEFAULT_INCLUDE_PATTERNS = ["**/*"];
const DEFAULT_EXCLUDE_PATTERNS = [
  ".git/**",
  ".ixado/**",
  "node_modules/**",
  "dist/**",
  "coverage/**",
];
const DEFAULT_PRIORITY_WEIGHTS: TodoFixmePriorityWeights = {
  recency: 0.4,
  frequency: 0.3,
  tags: 0.3,
};
const DEFAULT_TAG_WEIGHTS: TodoFixmeTagWeights = {
  TODO: 1,
  FIXME: 2,
};
const DEFAULT_MAX_FILE_SIZE_BYTES = 512_000;

const COMMENT_TAG_PATTERN =
  /(?:^|[^A-Za-z0-9_])(?:\/\/|#|--|;|\/\*+|\*+|<!--)\s*(TODO|FIXME)\b[:\-\s]*(.*)/i;

type RawFinding = {
  tag: TodoFixmeTag;
  text: string;
  filePath: string;
  line: number;
  lineText: string;
  modifiedAtMs: number;
  signature: string;
};

type ScannableFile = {
  absolutePath: string;
  relativePath: string;
};

type NormalizedPattern = {
  raw: string;
  segments: string[];
};

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function normalizePattern(pattern: string): NormalizedPattern {
  const normalized = normalizePath(pattern);
  if (!normalized) {
    throw new Error("Scanner pattern must be non-empty.");
  }
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new Error(`Invalid scanner pattern: "${pattern}"`);
  }
  return {
    raw: normalized,
    segments,
  };
}

function splitPathSegments(path: string): string[] {
  const normalized = normalizePath(path);
  if (!normalized) {
    return [];
  }
  return normalized.split("/").filter((segment) => segment.length > 0);
}

function matchPathSegment(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let matchedValueIndex = 0;

  while (valueIndex < value.length) {
    const currentPatternChar = pattern[patternIndex];
    const currentValueChar = value[valueIndex];

    if (currentPatternChar === "?" || currentPatternChar === currentValueChar) {
      patternIndex += 1;
      valueIndex += 1;
      continue;
    }

    if (currentPatternChar === "*") {
      starIndex = patternIndex;
      patternIndex += 1;
      matchedValueIndex = valueIndex;
      continue;
    }

    if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      matchedValueIndex += 1;
      valueIndex = matchedValueIndex;
      continue;
    }

    return false;
  }

  while (pattern[patternIndex] === "*") {
    patternIndex += 1;
  }

  return patternIndex === pattern.length;
}

function matchPathSegments(
  patternSegments: string[],
  pathSegments: string[],
  patternIndex: number,
  pathIndex: number,
): boolean {
  while (patternIndex < patternSegments.length) {
    const patternSegment = patternSegments[patternIndex];

    if (patternSegment === "**") {
      while (patternSegments[patternIndex + 1] === "**") {
        patternIndex += 1;
      }
      if (patternIndex === patternSegments.length - 1) {
        return true;
      }

      patternIndex += 1;
      for (
        let scanIndex = pathIndex;
        scanIndex <= pathSegments.length;
        scanIndex += 1
      ) {
        if (
          matchPathSegments(
            patternSegments,
            pathSegments,
            patternIndex,
            scanIndex,
          )
        ) {
          return true;
        }
      }
      return false;
    }

    if (pathIndex >= pathSegments.length) {
      return false;
    }

    if (!matchPathSegment(patternSegment, pathSegments[pathIndex])) {
      return false;
    }

    patternIndex += 1;
    pathIndex += 1;
  }

  return pathIndex === pathSegments.length;
}

function matchesGlob(pattern: NormalizedPattern, path: string): boolean {
  const pathSegments = splitPathSegments(path);
  return matchPathSegments(pattern.segments, pathSegments, 0, 0);
}

function sanitizeCommentText(raw: string): string {
  return raw
    .replace(/\*\/\s*$/, "")
    .replace(/-->\s*$/, "")
    .replace(/^[:\-\s]+/, "")
    .trim();
}

function buildSignature(tag: TodoFixmeTag, text: string): string {
  return `${tag}:${text.toLowerCase()}`;
}

function isProbablyText(content: Buffer): boolean {
  return !content.includes(0);
}

async function collectCandidateFiles(
  rootDir: string,
  includePatterns: NormalizedPattern[],
  excludePatterns: NormalizedPattern[],
): Promise<ScannableFile[]> {
  const files: ScannableFile[] = [];

  async function walk(
    currentDirectory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(currentDirectory, entry.name);
      const relativePath = normalizePath(join(relativeDirectory, entry.name));

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        const excluded = excludePatterns.some((pattern) =>
          matchesGlob(pattern, relativePath),
        );
        if (excluded) {
          continue;
        }
        await walk(absolutePath, relativePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const included = includePatterns.some((pattern) =>
        matchesGlob(pattern, relativePath),
      );
      if (!included) {
        continue;
      }

      const excluded = excludePatterns.some((pattern) =>
        matchesGlob(pattern, relativePath),
      );
      if (excluded) {
        continue;
      }

      files.push({ absolutePath, relativePath });
    }
  }

  await walk(rootDir, "");
  return files;
}

function extractFindingsFromSource(
  filePath: string,
  source: string,
  modifiedAtMs: number,
): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index] ?? "";
    const match = COMMENT_TAG_PATTERN.exec(lineText);
    if (!match) {
      continue;
    }

    const tag = (match[1] ?? "").toUpperCase() as TodoFixmeTag;
    if (tag !== "TODO" && tag !== "FIXME") {
      continue;
    }
    const text = sanitizeCommentText(match[2] ?? "");

    findings.push({
      tag,
      text,
      filePath,
      line: index + 1,
      lineText: lineText.trimEnd(),
      modifiedAtMs,
      signature: buildSignature(tag, text),
    });
  }

  return findings;
}

function mergePriorityWeights(
  override?: Partial<TodoFixmePriorityWeights>,
): TodoFixmePriorityWeights {
  return {
    recency: override?.recency ?? DEFAULT_PRIORITY_WEIGHTS.recency,
    frequency: override?.frequency ?? DEFAULT_PRIORITY_WEIGHTS.frequency,
    tags: override?.tags ?? DEFAULT_PRIORITY_WEIGHTS.tags,
  };
}

function mergeTagWeights(
  override?: Partial<TodoFixmeTagWeights>,
): TodoFixmeTagWeights {
  return {
    TODO: override?.TODO ?? DEFAULT_TAG_WEIGHTS.TODO,
    FIXME: override?.FIXME ?? DEFAULT_TAG_WEIGHTS.FIXME,
  };
}

function assertNonNegativeFinite(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Scanner ${fieldName} must be a non-negative finite number.`,
    );
  }
}

function normalizeScore(value: number, min: number, max: number): number {
  if (max <= min) {
    return 1;
  }
  return (value - min) / (max - min);
}

export async function scanTodoFixmeComments(
  options: TodoFixmeScannerOptions,
): Promise<TodoFixmeFinding[]> {
  const providedRoot = options.rootDir?.trim();
  if (!providedRoot) {
    throw new Error("Scanner rootDir is required.");
  }
  const normalizedRoot = resolve(providedRoot);

  const rootStats = await stat(normalizedRoot).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Scanner rootDir does not exist: ${normalizedRoot}`);
    }
    throw error;
  });
  if (!rootStats.isDirectory()) {
    throw new Error(`Scanner rootDir must be a directory: ${normalizedRoot}`);
  }

  const includePatterns = (
    options.includePatterns ?? DEFAULT_INCLUDE_PATTERNS
  ).map(normalizePattern);
  const excludePatterns = (
    options.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS
  ).map(normalizePattern);
  const priorityWeights = mergePriorityWeights(options.priorityWeights);
  const tagWeights = mergeTagWeights(options.tagWeights);
  const maxFileSizeBytes =
    options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  assertNonNegativeFinite(priorityWeights.recency, "priorityWeights.recency");
  assertNonNegativeFinite(
    priorityWeights.frequency,
    "priorityWeights.frequency",
  );
  assertNonNegativeFinite(priorityWeights.tags, "priorityWeights.tags");
  assertNonNegativeFinite(tagWeights.TODO, "tagWeights.TODO");
  assertNonNegativeFinite(tagWeights.FIXME, "tagWeights.FIXME");
  if (!Number.isFinite(maxFileSizeBytes) || maxFileSizeBytes <= 0) {
    throw new Error(
      "Scanner maxFileSizeBytes must be a positive finite number.",
    );
  }

  const candidateFiles = await collectCandidateFiles(
    normalizedRoot,
    includePatterns,
    excludePatterns,
  );

  const rawFindings: RawFinding[] = [];
  for (const file of candidateFiles) {
    const fileStats = await stat(file.absolutePath);
    if (fileStats.size > maxFileSizeBytes) {
      continue;
    }

    const rawContent = await readFile(file.absolutePath);
    if (!isProbablyText(rawContent)) {
      continue;
    }

    const source = rawContent.toString("utf8");
    rawFindings.push(
      ...extractFindingsFromSource(
        file.relativePath,
        source,
        fileStats.mtimeMs,
      ),
    );
  }

  if (rawFindings.length === 0) {
    return [];
  }

  const minModifiedAtMs = Math.min(
    ...rawFindings.map((item) => item.modifiedAtMs),
  );
  const maxModifiedAtMs = Math.max(
    ...rawFindings.map((item) => item.modifiedAtMs),
  );

  const frequencyBySignature = new Map<string, number>();
  for (const finding of rawFindings) {
    frequencyBySignature.set(
      finding.signature,
      (frequencyBySignature.get(finding.signature) ?? 0) + 1,
    );
  }
  const maxFrequency = Math.max(...frequencyBySignature.values());
  const maxTagWeight = Math.max(tagWeights.TODO, tagWeights.FIXME);

  const scored = rawFindings.map((finding): TodoFixmeFinding => {
    const frequency = frequencyBySignature.get(finding.signature) ?? 1;
    const recencyScore = normalizeScore(
      finding.modifiedAtMs,
      minModifiedAtMs,
      maxModifiedAtMs,
    );
    const frequencyScore = maxFrequency <= 0 ? 0 : frequency / maxFrequency;
    const tagWeight = tagWeights[finding.tag];
    const tagScore = maxTagWeight <= 0 ? 0 : tagWeight / maxTagWeight;
    const priorityScore =
      recencyScore * priorityWeights.recency +
      frequencyScore * priorityWeights.frequency +
      tagScore * priorityWeights.tags;

    return {
      tag: finding.tag,
      text: finding.text,
      filePath: finding.filePath,
      line: finding.line,
      lineText: finding.lineText,
      frequency,
      recencyScore,
      frequencyScore,
      tagScore,
      priorityScore,
    };
  });

  scored.sort((left, right) => {
    if (right.priorityScore !== left.priorityScore) {
      return right.priorityScore - left.priorityScore;
    }
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    if (left.tag !== right.tag) {
      return left.tag.localeCompare(right.tag);
    }
    return left.text.localeCompare(right.text);
  });

  return scored;
}
