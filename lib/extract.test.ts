import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { ExtractError, extractResumeText, extractedResumeError } from "./extract.ts";
import { MAX_INPUT_CHARS } from "./limits.ts";

function fixture(name: string) {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url)).then(
    (buffer) => new Uint8Array(buffer),
  );
}

describe("extractResumeText", () => {
  it("reads text from a pdf", async () => {
    const text = await extractResumeText("resume.pdf", await fixture("resume.pdf"));
    assert.match(text, /Python warehouse scripts/);
  });

  it("reads text from a docx", async () => {
    const text = await extractResumeText("resume.docx", await fixture("resume.docx"));
    assert.match(text, /учет склада в 1С/);
    assert.match(text, /Python/);
  });

  it("returns empty text for a pdf without a text layer", async () => {
    const text = await extractResumeText("empty.pdf", await fixture("empty.pdf"));
    assert.equal(text, "");
    assert.match(extractedResumeError(text) ?? "", /нет текста/);
  });

  it("reads utf-8 and windows-1251 txt", async () => {
    const utf8 = new TextEncoder().encode("Опыт в Python\n");
    assert.match(await extractResumeText("cv.txt", utf8), /Опыт в Python/);

    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    assert.equal(await extractResumeText("cv.txt", cp1251), "Привет");
  });

  it("rejects a file over 5 MB, legacy doc, and an unknown type", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    await assert.rejects(
      () => extractResumeText("cv.txt", big),
      (error: unknown) => error instanceof ExtractError && /5 МБ/.test(error.message),
    );
    await assert.rejects(
      () => extractResumeText("cv.doc", new Uint8Array([1, 2, 3])),
      (error: unknown) => error instanceof ExtractError && /DOC/.test(error.message),
    );
    await assert.rejects(
      () => extractResumeText("cv.rtf", new TextEncoder().encode("{\\rtf hi}")),
      (error: unknown) => error instanceof ExtractError && /PDF, DOCX и TXT/.test(error.message),
    );
    await assert.rejects(
      () => extractResumeText("cv.pdf", new TextEncoder().encode("not a pdf")),
      (error: unknown) => error instanceof ExtractError && /прочитать/.test(error.message),
    );
  });
});

describe("extractedResumeError", () => {
  it("asks to shorten text past the field limit", () => {
    const message = extractedResumeError("а".repeat(MAX_INPUT_CHARS + 1));
    assert.ok(message?.includes(String(MAX_INPUT_CHARS)));
    assert.equal(extractedResumeError("а".repeat(MAX_INPUT_CHARS)), null);
  });
});
