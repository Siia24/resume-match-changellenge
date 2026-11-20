import { z } from "zod";
import { AnalyzeError } from "./errors.ts";

const fixSchema = z.object({
  before: z.string().trim().min(1).max(500),
  after: z.string().trim().min(1).max(500),
  why: z.string().trim().min(1).max(300),
});

const analysisSchema = z
  .object({
    matchPercent: z.number().int().min(0).max(100),
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
    fixes: z.array(fixSchema).length(3),
  })
  .refine((value) => value.covered.length + value.gaps.length > 0, {
    message: "empty checklist",
  });

export type Analysis = z.infer<typeof analysisSchema>;

const BAD_SHAPE = "Модель вернула ответ в неожиданном виде. Попробуйте ещё раз.";

export function normalize(text: string): string {
  return text
    .replace(/[«»“”„"]/g, "")
    .replace(/[–—−]/g, "-")
    .replace(/ё/gi, "е")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ponytail: exact normalized substring (word match under 12 chars). Not a fuzzy match — loosen only if real quotes keep failing.
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

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new SyntaxError("not json");
  }
}

function coerce(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  const value = obj.matchPercent;
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    if (Number.isFinite(number)) obj.matchPercent = Math.round(number);
  } else if (typeof value === "number") {
    obj.matchPercent = Math.round(value);
  }
  return obj;
}

export function parseModelOutput(text: string, resume: string): Analysis {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    throw new AnalyzeError(502, BAD_SHAPE);
  }

  const parsed = analysisSchema.safeParse(coerce(raw));
  if (!parsed.success) throw new AnalyzeError(502, BAD_SHAPE);

  const analysis = parsed.data;
  for (const item of analysis.covered) {
    if (!textIncludesQuote(item.evidence, resume)) {
      throw new AnalyzeError(
        502,
        "Модель сослалась на опыт, которого нет в резюме. Попробуйте ещё раз.",
      );
    }
  }
  for (const fix of analysis.fixes) {
    if (!textIncludesQuote(fix.before, resume)) {
      throw new AnalyzeError(
        502,
        "Модель предложила правку не из текста резюме. Попробуйте ещё раз.",
      );
    }
    if (fix.before.replace(/\s+/g, " ").trim() === fix.after.replace(/\s+/g, " ").trim()) {
      throw new AnalyzeError(
        502,
        "Модель не изменила формулировку. Попробуйте ещё раз.",
      );
    }
  }
  return analysis;
}
