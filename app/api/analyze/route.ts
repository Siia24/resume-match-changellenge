import { AnalyzeError } from "@/lib/errors";
import { completeAnalysis, completeMoreFixes, listRequirements } from "@/lib/gigachat";
import { inputError } from "@/lib/limits";
import { buildAnalysis, parseModelOutput, readFixes, type Analysis } from "@/lib/parse";

export const maxDuration = 120;

function jsonError(status: number, error: string) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
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
  try {
    requirements = await listRequirements(vacancy);
  } catch (error) {
    if (!(error instanceof AnalyzeError)) throw error;
    console.error("gigachat requirements", error.message);
  }

  let analysis: Analysis;
  try {
    let text: string;
    try {
      text = await completeAnalysis(resume, vacancy, 0.3, requirements);
    } catch (error) {
      if (!(error instanceof AnalyzeError) || !error.retryable) throw error;
      text = await completeAnalysis(resume, vacancy, 0.5, requirements);
    }
    try {
      analysis = parseModelOutput(text, resume, requirements);
    } catch (error) {
      if (!(error instanceof AnalyzeError) || !error.retryable || !requirements.length) throw error;
      analysis = buildAnalysis(resume, requirements, []);
    }
  } catch (error) {
    if (error instanceof AnalyzeError) return jsonError(error.status, error.message);
    console.error("analyze", error instanceof Error ? error.message : "unknown");
    return jsonError(502, "Не удалось получить разбор. Попробуйте ещё раз.");
  }

  if (analysis.fixes.length < 3) {
    try {
      const more = await completeMoreFixes(
        resume,
        vacancy,
        requirements,
        analysis.fixes.map((fix) => fix.before),
        3 - analysis.fixes.length,
      );
      const extra = readFixes(more, resume, requirements);
      const list = requirements.length
        ? requirements
        : [...analysis.covered, ...analysis.partial, ...analysis.gaps].map((item) => item.requirement);
      analysis = buildAnalysis(resume, list, [...analysis.fixes, ...extra]);
    } catch (error) {
      console.error("gigachat fixes", error instanceof Error ? error.message : "error");
    }
  }
  return Response.json(analysis);
}
