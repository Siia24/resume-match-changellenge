import { AnalyzeError } from "@/lib/errors";
import { armGigachatBudget, chatBudget, listRequirements, rewriteLine } from "@/lib/gigachat";
import { inputError } from "@/lib/limits";
import {
  bestRequirement,
  buildAnalysis,
  lineAnswer,
  pickFixLines,
  readFixes,
  resumeLines,
  type Analysis,
  type ResumeLine,
} from "@/lib/parse";

export const maxDuration = 60;
const BUDGET_MS = 25_000;

type DebugCall = {
  name: string;
  ms: number;
  raw: { before: string; after: string; why: string }[];
};

function jsonError(status: number, error: string) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
  const debug = new URL(request.url).searchParams.get("debug") === "1";
  armGigachatBudget(BUDGET_MS);
  const calls: DebugCall[] = [];
  const dropped: { before: string; after: string; why: string; reason: string }[] = [];
  let refill = false;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Не удалось прочитать запрос.");
  }

  const resume = (body as { resume?: unknown })?.resume;
  const vacancy = (body as { vacancy?: unknown })?.vacancy;
  if (typeof resume !== "string" || typeof vacancy !== "string") {
    return jsonError(400, "Нужны тексты резюме и вакансии.");
  }
  const invalid = inputError(resume, vacancy);
  if (invalid) return jsonError(400, invalid);

  async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const value = await run();
      calls.push({
        name,
        ms: Date.now() - started,
        raw: Array.isArray(value)
          ? value
              .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
              .map((before) => ({ before, after: "", why: "" }))
          : [],
      });
      return value;
    } catch (error) {
      calls.push({ name, ms: Date.now() - started, raw: [] });
      throw error;
    }
  }

  let requirements: string[] = [];
  const requirementsTimeout = chatBudget(8_000);
  if (requirementsTimeout) {
    try {
      requirements = await timed("requirements", () => listRequirements(vacancy, requirementsTimeout));
    } catch (error) {
      if (!(error instanceof AnalyzeError)) throw error;
      console.error("gigachat requirements", error.message);
    }
  }

  const preview = buildAnalysis(resume, requirements, []);
  const evidence = [...preview.covered, ...preview.partial].map((item) => item.evidence);
  const list = requirements.length
    ? requirements
    : [...preview.covered, ...preview.partial, ...preview.gaps].map((item) => item.requirement);
  const chosen = pickFixLines(resume, vacancy, list, evidence);
  let fixes = await rewriteLines(chosen, list, resume, vacancy, []);

  async function rewriteLines(
    lines: ResumeLine[],
    requirements: string[],
    source: string,
    role: string,
    reasons: string[],
  ) {
    const timeout = chatBudget(12_000);
    if (!timeout || !lines.length) return [];
    const accepted: { index: number; fixes: Analysis["fixes"] }[] = [];
    await Promise.all(
      lines.map(async (line, index) => {
        const requirement = bestRequirement(line.text, requirements);
        const started = Date.now();
        let after = "";
        let why = "";
        try {
          const raw = await rewriteLine(line.text, requirement, timeout, reasons);
          const answer = lineAnswer(raw);
          after = answer.after;
          why = answer.why;
        } catch (error) {
          console.error(`parse fix ${line.id} ${error instanceof Error ? error.message : "error"}`);
        }
        calls.push({
          name: `fix_${line.id}`,
          ms: Date.now() - started,
          raw: [{ before: line.text, after, why }],
        });
        if (!after) {
          dropped.push({ before: line.text, after: "", why, reason: "empty" });
          return;
        }
        const review = readFixes(
          JSON.stringify({
            fixes: [{ lineId: line.id, requirement, after, why: why || "Правка." }],
          }),
          source,
          requirements,
          role,
          true,
        );
        dropped.push(...review.dropped);
        accepted.push({ index, fixes: review.fixes });
      }),
    );
    return accepted.sort((a, b) => a.index - b.index).flatMap((item) => item.fixes);
  }
  if (fixes.length < 3) {
    const retryTimeout = chatBudget(8_000);
    const used = new Set(fixes.map((fix) => fix.before.replace(/\s+/g, " ").trim()));
    const rest = resumeLines(resume)
      .filter((line) => !used.has(line.text.replace(/\s+/g, " ").trim()))
      .filter((line) => !chosen.some((item) => item.id === line.id))
      .slice(0, 6);
    if (retryTimeout && rest.length) {
      refill = true;
      console.error(`parse fixes kept ${fixes.length}, refill ${rest.map((line) => line.id).join(",")}`);
      const more = await rewriteLines(
        rest,
        list,
        resume,
        vacancy,
        dropped.map((item) => item.reason),
      );
      fixes = [...fixes, ...more];
    }
  }
  const analysis: Analysis = buildAnalysis(resume, list, fixes);

  return Response.json(debug ? { ...analysis, debug: { calls, dropped, refill } } : analysis);
}

