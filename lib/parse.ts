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
    fixes: z.array(fixSchema).max(8),
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

function balancedSlice(text: string): string | null {
  const objAt = text.indexOf("{");
  const arrAt = text.indexOf("[");
  if (objAt < 0 && arrAt < 0) return null;
  const start = objAt < 0 ? arrAt : arrAt < 0 ? objAt : Math.min(objAt, arrAt);
  const open = text[start];
  const close = open === "{" ? "}" : "]";
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
    else if (ch === open) depth += 1;
    else if (ch === close) {
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
  const candidates = [raw, balancedSlice(raw), balancedSlice(trimmed)].filter(
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trim();
}

function sanitizeModel(raw: unknown): { value: unknown; dropped: string[] } {
  const obj = asRecord(raw);
  if (!obj) return { value: raw, dropped: [] };
  const dropped: string[] = [];
  const covered = (Array.isArray(obj.covered) ? obj.covered : []).flatMap((item) => {
    const row = asRecord(item);
    const requirement = textField(row?.requirement, 300);
    const evidence = textField(row?.evidence, 500);
    if (!requirement || !evidence) {
      dropped.push("covered");
      return [];
    }
    return [{ requirement, evidence }];
  });
  const gaps = (Array.isArray(obj.gaps) ? obj.gaps : []).flatMap((item) => {
    const requirement = textField(asRecord(item)?.requirement, 300);
    if (!requirement) {
      dropped.push("gaps");
      return [];
    }
    return [{ requirement }];
  });
  const fixes = (Array.isArray(obj.fixes) ? obj.fixes : []).flatMap((item) => {
    const row = asRecord(item);
    const before = textField(row?.before, 500);
    const after = textField(row?.after, 500);
    const why = textField(row?.why, 300);
    if (!before || !after || !why) {
      dropped.push("fixes");
      return [];
    }
    return [{ before, after, why }];
  });
  return {
    value: {
      matchExplanation: textField(obj.matchExplanation, 280) ?? "",
      covered: covered.slice(0, 30),
      gaps: gaps.slice(0, 30),
      fixes: fixes.slice(0, 8),
    },
    dropped,
  };
}

function sameRequirement(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 8 && b.length >= 8 && (a.includes(b) || b.includes(a));
}

function alignRequirements(
  covered: { requirement: string; evidence: string }[],
  requirements: string[],
): { covered: { requirement: string; evidence: string }[]; gaps: { requirement: string }[] } {
  const used = new Set<number>();
  const nextCovered: { requirement: string; evidence: string }[] = [];
  const gaps: { requirement: string }[] = [];
  for (const requirement of requirements) {
    const index = covered.findIndex(
      (item, itemIndex) => !used.has(itemIndex) && sameRequirement(item.requirement, requirement),
    );
    if (index >= 0) {
      used.add(index);
      nextCovered.push({ requirement, evidence: covered[index].evidence });
    } else {
      gaps.push({ requirement });
    }
  }
  return { covered: nextCovered, gaps };
}

export function readRequirementList(text: string): string[] {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return [];
  }
  const list = Array.isArray(raw)
    ? raw
    : asRecord(raw) && Array.isArray(asRecord(raw)?.requirements)
      ? (asRecord(raw)?.requirements as unknown[])
      : [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of list) {
    const requirement = textField(item, 300);
    const key = requirement ? normalize(requirement) : "";
    if (!requirement || !key || seen.has(key)) continue;
    seen.add(key);
    items.push(requirement);
  }
  return items.slice(0, 12);
}

export function parseModelOutput(
  text: string,
  resume: string,
  requirements: string[] = [],
): Analysis {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    logParse("not json", text);
    throw new AnalyzeError(502, BAD_SHAPE, true);
  }

  const sanitized = sanitizeModel(raw);
  if (sanitized.dropped.length) logParse(`drop empty ${sanitized.dropped.join(" ")}`, text);
  const parsed = analysisSchema.safeParse(sanitized.value);
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

  const checklist = requirements.length
    ? alignRequirements(covered, requirements)
    : { covered, gaps: parsed.data.gaps };
  return {
    ...parsed.data,
    covered: checklist.covered,
    gaps: checklist.gaps,
    fixes,
    matchPercent: matchPercent(checklist.covered.length, checklist.gaps.length),
  };
}
