import { AnalyzeError } from "@/lib/errors";
import {
  armGigachatBudget,
  chatBudget,
  askHint,
  httpFailureReason,
  listRequirements,
  matchVacancy,
} from "@/lib/gigachat";
import { inputError } from "@/lib/limits";
import {
  buildAnalysis,
  hintSlots,
  hintTemplate,
  lineAnswer,
  readModelMatch,
  rejectHint,
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
  armGigachatBudget(25_000);
  const fixes = await collectHints(hintSlots(resume, preview).slice(0, 3), vacancy);
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

  async function collectHints(slots: { before: string; requirement: string }[], role: string) {
    const accepted: Analysis["fixes"] = [];
    for (const [index, slot] of slots.entries()) {
      const timeout = chatBudget(12_000);
      let hint = "";
      if (timeout) {
        let outcome = await ask(slot, index, timeout, role);
        if (outcome.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const retry = chatBudget(12_000);
          if (retry) outcome = await ask(slot, index, retry, role);
        }
        const http = httpFailureReason(outcome.status);
        if (http || (outcome.status === 0 && outcome.error)) {
          dropped.push({ before: slot.before, after: "", why: "", reason: http ?? outcome.error });
        } else if (!outcome.hint) {
          dropped.push({ before: slot.before, after: "", why: "", reason: outcome.reason || "empty" });
        } else {
          hint = outcome.hint;
        }
      }
      if (!hint) hint = hintTemplate(slot.requirement, slot.before);
      accepted.push({ before: slot.before, requirement: slot.requirement, hint });
    }
    return accepted;
  }

  async function ask(
    slot: { before: string; requirement: string },
    index: number,
    timeout: number,
    role: string,
  ) {
    const started = Date.now();
    const name = `hint_${index + 1}`;
    try {
      const raw = await askHint(slot.before, slot.requirement, role, timeout);
      const answer = lineAnswer(raw, slot.before);
      calls.push({ name, ms: Date.now() - started, status: 200, error: "", raw });
      const reason = rejectHint(answer.after, `${slot.before}\n${role}\n${slot.requirement}`);
      return { status: 200, error: "", hint: reason ? "" : answer.after, reason: reason ?? "" };
    } catch (error) {
      const failed = failedCall(name, started, error);
      calls.push(failed);
      console.error(`parse hint ${name} ${failed.error}`);
      return { status: failed.status, error: failed.error, hint: "", reason: "" };
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

