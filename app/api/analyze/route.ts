import { AnalyzeError } from "@/lib/errors";
import { completeAnalysis, listRequirements } from "@/lib/gigachat";
import { inputError } from "@/lib/limits";
import { parseModelOutput } from "@/lib/parse";

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

  try {
    try {
      const text = await completeAnalysis(resume, vacancy, 0.3, requirements);
      return Response.json(parseModelOutput(text, resume, requirements));
    } catch (error) {
      if (!(error instanceof AnalyzeError) || !error.retryable) throw error;
      const text = await completeAnalysis(resume, vacancy, 0.6, requirements);
      return Response.json(parseModelOutput(text, resume, requirements));
    }
  } catch (error) {
    if (error instanceof AnalyzeError) return jsonError(error.status, error.message);
    console.error("analyze", error instanceof Error ? error.message : "unknown");
    return jsonError(502, "Не удалось получить разбор. Попробуйте ещё раз.");
  }
}
