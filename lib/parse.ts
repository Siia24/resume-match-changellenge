import { z } from "zod";
import { AnalyzeError } from "./errors.ts";

const fixSchema = z.object({
  before: z.string().trim().min(1).max(500),
  after: z.string().trim().min(1).max(500),
  why: z.string().trim().min(1).max(300),
});

const analysisSchema = z
  .object({
    matchExplanation: z.string().trim().min(1).max(280),
    covered: z
      .array(
        z.object({
          requirement: z.string().trim().min(1).max(300),
          evidence: z.string().trim().min(1).max(500),
        }),
      )
      .max(30),
    gaps: z
      .array(
        z.object({
          requirement: z.string().trim().min(1).max(300),
        }),
      )
      .max(30),
    fixes: z.array(fixSchema).min(1).max(8),
  });

export type Analysis = z.infer<typeof analysisSchema> & { matchPercent: number };

const BAD_SHAPE = "Модель вернула ответ в неожиданном виде. Попробуйте ещё раз.";

export function normalize(text: string): string {
  return text
    .replace(/[«»“”„"]/g, "")
    .replace(/[–—−]/g, "-")
    .replace(/ё/gi, "е")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?…]+$/u, "")
    .trim()
    .toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ponytail: normalized substring, trailing punctuation stripped. Not a fuzzy match.
export function textIncludesQuote(quote: string, source: string): boolean {
  const needle = normalize(quote);
  const haystack = normalize(source);
  if (!needle) return false;
  if (needle.length >= 12) return haystack.includes(needle);
  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?:$|[^\\p{L}\\p{N}_])`,
    "u",
  );
  return pattern.test(haystack);
}

function balancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? trimmed).trim();
  const candidates = [raw, balancedObject(raw), balancedObject(trimmed)].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next candidate
    }
  }
  throw new SyntaxError("not json");
}

function logParse(rule: string, snippet: string) {
  const body = snippet.replace(/\s+/g, " ").trim().slice(0, 180);
  console.error(`parse ${rule} body ${body}`);
}

function matchPercent(covered: number, gaps: number): number {
  const total = covered + gaps;
  if (total === 0) return 0;
  return Math.round((100 * covered) / total);
}

export function parseModelOutput(text: string, resume: string): Analysis {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    logParse("not json", text);
    throw new AnalyzeError(502, BAD_SHAPE, true);
  }

  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) {
    const rule = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    logParse(rule, text);
    throw new AnalyzeError(502, BAD_SHAPE, true);
  }

  const covered = parsed.data.covered.filter((item) => {
    if (textIncludesQuote(item.evidence, resume)) return true;
    logParse("drop covered evidence", item.evidence);
    return false;
  });
  const fixes = parsed.data.fixes
    .filter((fix) => {
      if (!textIncludesQuote(fix.before, resume)) {
        logParse("drop fix before", fix.before);
        return false;
      }
      if (fix.before.replace(/\s+/g, " ").trim() === fix.after.replace(/\s+/g, " ").trim()) {
        logParse("drop unchanged fix", fix.before);
        return false;
      }
      return true;
    })
    .slice(0, 3);
  if (fixes.length < 1) {
    logParse("fewer than 1 grounded fix", text);
    throw new AnalyzeError(
      502,
      "Модель предложила правку не из текста резюме. Попробуйте ещё раз.",
      true,
    );
  }

  return {
    ...parsed.data,
    covered,
    fixes,
    matchPercent: matchPercent(covered.length, parsed.data.gaps.length),
  };
}
