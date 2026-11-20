export const MIN_INPUT_CHARS = 40;
export const MAX_INPUT_CHARS = 8000;

export function inputError(resume: string, vacancy: string): string | null {
  if (typeof resume !== "string" || typeof vacancy !== "string") {
    return "Нужны тексты резюме и вакансии.";
  }
  if (
    resume.trim().length < MIN_INPUT_CHARS ||
    vacancy.trim().length < MIN_INPUT_CHARS
  ) {
    return "Вставьте текст резюме и текст вакансии целиком.";
  }
  if (resume.length > MAX_INPUT_CHARS || vacancy.length > MAX_INPUT_CHARS) {
    return `Каждый текст — не длиннее ${MAX_INPUT_CHARS} символов.`;
  }
  return null;
}
