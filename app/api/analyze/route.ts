import { AnalyzeError } from "@/lib/errors";
import { armGigachatBudget, chatBudget, listRequirements, matchVacancy } from "@/lib/gigachat";
import { inputError } from "@/lib/limits";
import {
  buildAnalysis,
  hintSlots,
  hintTemplate,
  readModelMatch,
  unionExplicitCovered,
  type Analysis,
} from "@/lib/parse";

export const maxDuration = 60;

type DebugCall = {
  name: string;
  ms: number;
  status: number;
  error: string;
  raw: string;
};

function jsonError(status: number, error: string) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
  const debug = new URL(request.url).searchParams.get("debug") === "1";
  const calls: DebugCall[] = [];
  const dropped: { before: string; after: string; why: string; reason: string }[] = [];
  const refill = false;

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

  let requirements: string[] = [];
  armGigachatBudget(8_000);
  const requirementsTimeout = chatBudget(8_000);
  if (requirementsTimeout) {
    const started = Date.now();
    try {
      const listed = await listRequirements(vacancy, requirementsTimeout);
      requirements = listed.items;
      calls.push({
        name: "requirements",
        ms: Date.now() - started,
        status: 200,
        error: "",
        raw: listed.raw,
      });
    } catch (error) {
      calls.push(failedCall("requirements", started, error));
      if (!(error instanceof AnalyzeError)) throw error;
      console.error("gigachat requirements", error.message);
    }
  }

  let preview = await modelAnalysis(resume, vacancy, requirements);
  if (!preview) preview = buildAnalysis(resume, requirements, []);
  const fixes = hintSlots(resume, preview).map((slot) => ({
    before: slot.before,
    requirement: slot.requirement,
    hint: hintTemplate(slot.requirement),
  }));
  const analysis: Analysis = { ...preview, fixes };
  return Response.json(debug ? { ...analysis, debug: { calls, dropped, refill } } : analysis);

  async function modelAnalysis(resume: string, vacancy: string, requirements: string[]) {
    armGigachatBudget(12_000);
    const timeout = chatBudget(12_000);
    if (!timeout) return null;
    const started = Date.now();
    try {
      const raw = await matchVacancy(resume, vacancy, requirements, timeout);
      const parsed = readModelMatch(raw, resume, requirements);
      const merged = parsed ? unionExplicitCovered(parsed, resume, requirements) : null;
      calls.push({
        name: "analysis",
        ms: Date.now() - started,
        status: 200,
        error: merged ? "" : "локальный фолбэк",
        raw,
      });
      return merged;
    } catch (error) {
      calls.push(failedCall("analysis", started, error));
      if (!(error instanceof AnalyzeError)) throw error;
      console.error("gigachat analysis", error.message);
      return null;
    }
  }
}

function failedCall(name: string, started: number, error: unknown): DebugCall {
  return {
    name,
    ms: Date.now() - started,
    status: error instanceof AnalyzeError ? error.httpStatus : 0,
    error: error instanceof Error ? error.message : "error",
    raw: error instanceof AnalyzeError ? error.body : "",
  };
}

