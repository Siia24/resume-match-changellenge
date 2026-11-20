import { AnalyzeError } from "@/lib/errors";
import {
  armGigachatBudget,
  chatBudget,
  httpFailureReason,
  listRequirements,
  matchVacancy,
  rewriteLine,
} from "@/lib/gigachat";
import { inputError } from "@/lib/limits";
import {
  bestRequirement,
  buildAnalysis,
  lineAnswer,
  pickFixLines,
  readFixes,
  readModelMatch,
  type Analysis,
  type ResumeLine,
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
  const evidence = [...preview.covered, ...preview.partial].map((item) => item.evidence);
  const list = requirements.length
    ? requirements
    : [...preview.covered, ...preview.partial, ...preview.gaps].map((item) => item.requirement);

  armGigachatBudget(25_000);
  const fixes = await rewriteLines(pickFixLines(resume, vacancy, list, evidence), list, resume, vacancy);
  const analysis: Analysis = { ...preview, fixes: fixes.slice(0, 3) };
  return Response.json(debug ? { ...analysis, debug: { calls, dropped, refill } } : analysis);

  async function modelAnalysis(resume: string, vacancy: string, requirements: string[]) {
    armGigachatBudget(12_000);
    const timeout = chatBudget(12_000);
    if (!timeout) return null;
    const started = Date.now();
    try {
      const raw = await matchVacancy(resume, vacancy, requirements, timeout);
      const parsed = readModelMatch(raw, resume, requirements);
      calls.push({
        name: "analysis",
        ms: Date.now() - started,
        status: 200,
        error: parsed ? "" : "локальный фолбэк",
        raw,
      });
      return parsed;
    } catch (error) {
      calls.push(failedCall("analysis", started, error));
      if (!(error instanceof AnalyzeError)) throw error;
      console.error("gigachat analysis", error.message);
      return null;
    }
  }

  async function rewriteLines(
    lines: ResumeLine[],
    requirements: string[],
    source: string,
    role: string,
  ) {
    const accepted: Analysis["fixes"] = [];
    for (const line of lines) {
      if (accepted.length >= 3) break;
      const timeout = chatBudget(12_000);
      if (!timeout) break;
      const requirement = bestRequirement(line.text, requirements);
      let outcome = await ask(line, requirement, timeout);
      if (outcome.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const retry = chatBudget(12_000);
        if (retry) outcome = await ask(line, requirement, retry);
      }
      const http = httpFailureReason(outcome.status);
      if (http || (outcome.status === 0 && outcome.error)) {
        dropped.push({
          before: line.text,
          after: "",
          why: "",
          reason: http ?? outcome.error,
        });
        continue;
      }
      if (!outcome.after) {
        dropped.push({ before: line.text, after: "", why: outcome.why, reason: "empty" });
        continue;
      }
      const review = readFixes(
        JSON.stringify({
          fixes: [{ lineId: line.id, requirement, after: outcome.after, why: outcome.why || "Правка." }],
        }),
        source,
        requirements,
        role,
        true,
      );
      dropped.push(...review.dropped);
      accepted.push(...review.fixes);
    }
    return accepted;
  }

  async function ask(line: ResumeLine, requirement: string, timeout: number) {
    const started = Date.now();
    try {
      const raw = await rewriteLine(line.text, requirement, timeout);
      const answer = lineAnswer(raw, line.text);
      calls.push({ name: `fix_${line.id}`, ms: Date.now() - started, status: 200, error: "", raw });
      return {
        status: 200,
        error: "",
        after: answer.after,
        why: `Подсвечивает требование: ${requirement}`,
      };
    } catch (error) {
      const failed = failedCall(`fix_${line.id}`, started, error);
      calls.push(failed);
      console.error(`parse fix ${line.id} ${failed.error}`);
      return { status: failed.status, error: failed.error, after: "", why: "" };
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

