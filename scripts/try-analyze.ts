import { completeAnalysis, listRequirements } from "../lib/gigachat.ts";
import { parseModelOutput } from "../lib/parse.ts";

const resume =
  "Веду рабочие задачи в Cursor и ChatGPT. Смотрю отчёты в Яндекс Метрике. Делаю сверки и отчёты в Excel.";
const vacancy =
  "Нужен человек, который владеет AI-инструментами, смотрит продуктовые метрики, умеет работать с данными и коммуникабелен.";

async function main() {
  if (!process.env.GIGACHAT_AUTH_KEY?.trim()) {
    console.log("Нет GIGACHAT_AUTH_KEY, запрос к GigaChat не отправляю.");
    return;
  }
  const requirements = await listRequirements(vacancy);
  const text = await completeAnalysis(resume, vacancy, 0.3, requirements);
  const analysis = parseModelOutput(text, resume, requirements);
  console.log(JSON.stringify({ requirements, analysis }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "error");
  process.exit(1);
});
