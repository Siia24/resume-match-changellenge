import { AnalyzeError } from "@/lib/errors";
import { armGigachatBudget, chatBudget, completeAnalysis, completeMoreFixes, listRequirements } from "@/lib/gigachat";
import { inputError } from "@/lib/limits";
import {
  assembleFixes,
  buildAnalysis,
  parseModelOutput,
  rawModelFixes,
  readFixes,
  type Analysis,
} from "@/lib/parse";

export const maxDuration = 60;
const BUDGET_MS = 48_000;

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
          : typeof value === "string"
            ? rawModelFixes(value)
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
  let analysis: Analysis | null = null;
  let text = "";
  const analysisTimeout = chatBudget(16_000);
  if (analysisTimeout) {
    try {
      text = await timed("analysis", () =>
        completeAnalysis(resume, vacancy, 0.3, requirements, analysisTimeout, evidence),
      );
    } catch (error) {
      if (!(error instanceof AnalyzeError) || !error.retryable) {
        if (requirements.length) analysis = buildAnalysis(resume, requirements, []);
        else return fail(error, debug, calls, refill);
      } else {
        const retryTimeout = chatBudget(12_000);
        if (retryTimeout) {
          try {
            text = await timed("retry", () =>
              completeAnalysis(resume, vacancy, 0.5, requirements, retryTimeout, evidence),
            );
          } catch (retryError) {
            if (requirements.length) analysis = buildAnalysis(resume, requirements, []);
            else return fail(retryError, debug, calls, refill);
          }
        } else if (requirements.length) {
          analysis = buildAnalysis(resume, requirements, []);
        } else {
          return fail(error, debug, calls, refill);
        }
      }
    }
  } else if (requirements.length) {
    analysis = buildAnalysis(resume, requirements, []);
  } else {
    return jsonError(502, "GigaChat не успел ответить. Попробуйте ещё раз.");
  }

  if (!analysis && text) {
    try {
      analysis = parseModelOutput(text, resume, requirements, vacancy);
    } catch (error) {
      if (!(error instanceof AnalyzeError) || !requirements.length) return fail(error, debug, calls, refill);
      analysis = buildAnalysis(resume, requirements, []);
    }
  }
  if (!analysis) analysis = buildAnalysis(resume, requirements, []);

  const list = requirements.length
    ? requirements
    : [...analysis.covered, ...analysis.partial, ...analysis.gaps].map((item) => item.requirement);
  let reasons: string[] = [];
  if (text) {
    try {
      const review = readFixes(text, resume, list, vacancy, true);
      reasons = review.reasons;
      dropped.push(...review.dropped);
    } catch {
      reasons = ["not json"];
    }
  }
  const refillTimeout = analysis.fixes.length < 3 ? chatBudget(12_000) : null;
  if (refillTimeout) {
    refill = true;
    const need = 3 - analysis.fixes.length;
    console.error(`parse fixes kept ${analysis.fixes.length}, refill ${need}: ${reasons.slice(0, 8).join("; ")}`);
    let more = "";
    try {
      more = await timed("fixes", () =>
        completeMoreFixes(
          resume,
          vacancy,
          list,
          analysis!.fixes.map((fix) => fix.before),
          need,
          reasons,
          refillTimeout,
          evidence,
        ),
      );
    } catch (error) {
      console.error(`parse fixes refill failed ${error instanceof Error ? error.message : "error"}`);
    }
    if (more) {
      try {
        dropped.push(...readFixes(more, resume, list, vacancy, true).dropped);
      } catch {
        dropped.push({ before: "", after: "", why: "", reason: "not json" });
      }
    }
    analysis = buildAnalysis(
      resume,
      list,
      assembleFixes(resume, vacancy, list, analysis.fixes, more ? [more] : []),
    );
  }

  return Response.json(debug ? { ...analysis, debug: { calls, dropped, refill } } : analysis);
}

function fail(error: unknown, debug: boolean, calls: DebugCall[], refill: boolean) {
  const message =
    error instanceof AnalyzeError
      ? error.message
      : "Не удалось получить разбор. Попробуйте ещё раз.";
  const status = error instanceof AnalyzeError ? error.status : 502;
  if (!(error instanceof AnalyzeError)) {
    console.error("analyze", error instanceof Error ? error.message : "unknown");
  }
  return Response.json(debug ? { error: message, debug: { calls, dropped: [], refill } } : { error: message }, {
    status,
  });
}
