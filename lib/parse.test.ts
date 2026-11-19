import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnalyzeError } from "./errors.ts";
import { parseModelOutput, textIncludesQuote } from "./parse.ts";

const resume =
  "Три года вел учет склада в 1С. Писал скрипты на Python для остатков. Окончил бакалавриат по экономике.";

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    matchPercent: 40,
    matchExplanation: "Закрыта часть требований.",
    covered: [{ requirement: "Python", evidence: "Писал скрипты на Python" }],
    gaps: [{ requirement: "SQL" }],
    fixes: [
      {
        before: "вел учет склада в 1С",
        after: "Вёл учёт склада в 1С",
        why: "Так требование видно сразу.",
      },
      {
        before: "Писал скрипты на Python для остатков",
        after: "Писал скрипты на Python для учёта остатков",
        why: "Яснее, без новых фактов.",
      },
      {
        before: "Окончил бакалавриат по экономике",
        after: "Бакалавриат по экономике",
        why: "Короче та же мысль.",
      },
    ],
    ...overrides,
  });
}

describe("parseModelOutput", () => {
  it("accepts fenced json grounded in the resume", () => {
    const analysis = parseModelOutput("```json\n" + payload() + "\n```", resume);
    assert.equal(analysis.matchPercent, 40);
    assert.equal(analysis.fixes.length, 3);
  });

  it("rejects a quote the resume does not contain", () => {
    const raw = payload({
      fixes: [
        {
          before: "Сократил время инвентаризации на 30%",
          after: "Сократил время инвентаризации",
          why: "Убрали цифру.",
        },
        {
          before: "вел учет склада в 1С",
          after: "Вёл учёт склада в 1С",
          why: "Орфография.",
        },
        {
          before: "Писал скрипты на Python для остатков",
          after: "Писал скрипты на Python",
          why: "Короче.",
        },
      ],
    });
    assert.throws(() => parseModelOutput(raw, resume), AnalyzeError);
  });

  it("rejects prose instead of json", () => {
    assert.throws(
      () => parseModelOutput("Вот общий совет: улучшите резюме.", resume),
      (error: unknown) =>
        error instanceof AnalyzeError &&
        error.message.includes("неожиданном виде"),
    );
  });
});

describe("textIncludesQuote", () => {
  it("matches a short skill as a word and folds ё", () => {
    assert.equal(textIncludesQuote("Python", resume), true);
    assert.equal(textIncludesQuote("Go", resume), false);
    assert.equal(textIncludesQuote("Вёл учёт склада в 1С", resume), true);
  });
});
