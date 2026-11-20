import { MAX_INPUT_CHARS } from "./limits.ts";

// In the browser: a Vercel Hobby function rejects bodies around 4.5 MB, and a resume file may be 5 MB.
export const MAX_RESUME_FILE_BYTES = 5 * 1024 * 1024;

// ponytail: 30 pages — raise if a real resume is longer.
const MAX_PDF_PAGES = 30;

export const RESUME_FILE_TOO_BIG =
  "Файл больше 5 МБ. Сохраните резюме меньшим файлом или вставьте текст.";

const UNSUPPORTED = "Поддерживаются файлы PDF, DOCX и TXT.";
const UNREADABLE =
  "Не удалось прочитать файл. Проверьте, что это PDF, DOCX или TXT.";
const DOC = "Формат DOC не читается. Сохраните резюме как DOCX или PDF.";
const TOO_MANY_PAGES = `В PDF больше ${MAX_PDF_PAGES} страниц. Для резюме вставьте текст вручную.`;
const EMPTY =
  "В файле нет текста. Если это скан PDF, скопируйте текст вручную.";

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

export function extractedResumeError(text: string): string | null {
  if (!text.trim()) return EMPTY;
  if (text.length > MAX_INPUT_CHARS) {
    return `В файле ${text.length} символов. Нужно не больше ${MAX_INPUT_CHARS} — сократите текст в поле.`;
  }
  return null;
}

export async function extractResumeText(filename: string, data: Uint8Array): Promise<string> {
  if (data.byteLength > MAX_RESUME_FILE_BYTES) throw new ExtractError(RESUME_FILE_TOO_BIG);

  const ext = extension(filename);
  try {
    if (ext === "doc") throw new ExtractError(DOC);
    if (ext === "pdf") {
      if (!isPdf(data)) throw new ExtractError(UNREADABLE);
      return tidy(await pdfText(data));
    }
    if (ext === "docx") {
      if (!isZip(data)) throw new ExtractError(UNREADABLE);
      return tidy(await docxText(data));
    }
    if (ext === "txt") return tidy(decodeText(data));
    throw new ExtractError(UNSUPPORTED);
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    throw new ExtractError(UNREADABLE);
  }
}

function extension(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function isPdf(data: Uint8Array): boolean {
  return (
    data.length >= 5 &&
    data[0] === 0x25 &&
    data[1] === 0x50 &&
    data[2] === 0x44 &&
    data[3] === 0x46 &&
    data[4] === 0x2d
  );
}

function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

function tidy(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\u00ad/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeText(data: Uint8Array): string {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(data);
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(data);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1251").decode(data);
  }
}

async function docxText(data: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth/mammoth.browser.js");
  const extractRawText = mammoth.extractRawText ?? mammoth.default.extractRawText;
  const copy = data.slice();
  const arrayBuffer = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
  const result = await extractRawText({ arrayBuffer });
  return result.value;
}

async function pdfText(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data.slice(), { maxImageSize: 16_777_216 });
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new ExtractError(TOO_MANY_PAGES);
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}
