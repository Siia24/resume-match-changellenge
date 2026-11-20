import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnalyzeError } from "./errors.ts";
import { normalize, parseModelOutput, readRequirementList, textIncludesQuote } from "./parse.ts";

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

const fix = (before: string, after: string) => ({
  before,
  after,
  why: "Та же мысль ближе к вакансии.",
});

describe("parseModelOutput", () => {
  it("reads json from a fence and extra text, and recomputes the percent", () => {
    const raw = payload({
      matchPercent: 20,
      covered: [
        { requirement: "Python", evidence: "Писал скрипты на Python" },
        { requirement: "1С", evidence: "учет склада в 1С." },
      ],
      gaps: [
        { requirement: "SQL" },
        { requirement: "Excel" },
      ],
    });
    const analysis = parseModelOutput("Вот разбор:\n```json\n" + raw + "\n```\nГотово.", resume);
    assert.equal(analysis.matchPercent, 50);
    assert.equal(analysis.covered.length, 2);
    assert.equal(analysis.fixes.length, 3);
  });

  it("drops one ungrounded fix and one ungrounded evidence", () => {
    const analysis = parseModelOutput(
      payload({
        covered: [
          { requirement: "Python", evidence: "Писал скрипты на Python" },
          { requirement: "SQL", evidence: "Опыт SQL, которого нет в резюме" },
        ],
        gaps: [{ requirement: "Excel" }],
        fixes: [
          fix("Сократил время инвентаризации на 30%", "Сократил время инвентаризации"),
          fix("вел учет склада в 1С", "Вёл учёт склада в 1С"),
          fix("Писал скрипты на Python для остатков", "Писал скрипты на Python"),
          fix("Окончил бакалавриат по экономике", "Бакалавриат по экономике"),
          fix("скрипты на Python для остатков", "Скрипты на Python для остатков склада"),
          fix("нет такой строки в резюме совсем", "Другая строка"),
        ],
      }),
      resume,
    );
    assert.equal(analysis.covered.length, 1);
    assert.equal(analysis.fixes.length, 3);
    assert.equal(analysis.fixes.some((item) => item.before.includes("30%")), false);
    assert.equal(
      analysis.fixes.some((item) => item.before === "скрипты на Python для остатков"),
      false,
    );
    assert.equal(analysis.matchPercent, 50);
  });

  it("fails only when no grounded fix remains", () => {
    assert.throws(
      () =>
        parseModelOutput(
          payload({
            fixes: [
              fix("Сократил время на 30%", "Сократил время"),
              fix("Вырос доход отдела", "Доход отдела вырос"),
            ],
          }),
          resume,
        ),
      (error: unknown) => error instanceof AnalyzeError && error.retryable,
    );
  });

  it("drops the empty placeholder covered item from the live payload", () => {
    const live =
      '{"matchPercent":0,"matchExplanation":"Нет пересечения опыта и навыков кандидата с требованиями вакансии.","covered":[{"requirement":"","evidence":""}],"gaps":[{"requirement":"опыт с данными"}],"fixes":[{"before":"вел учет склада в 1С","after":"Вёл учёт склада в 1С","why":"Так требование видно сразу."},{"before":"Писал скрипты на Python для остатков","after":"Писал скрипты на Python для учёта остатков","why":"Яснее."},{"before":"Окончил бакалавриат по экономике","after":"Бакалавриат по экономике","why":"Короче."}]}';
    const analysis = parseModelOutput(live, resume);
    assert.equal(analysis.covered.length, 0);
    assert.equal(analysis.gaps[0]?.requirement, "опыт с данными");
    assert.equal(analysis.matchPercent, 0);
    assert.equal(analysis.fixes.length, 3);
    assert.match(analysis.matchExplanation, /Нет пересечения/);
  });

  it("keeps the vacancy requirement list and fills missing items as gaps", () => {
    const sample =
      "Веду задачи в Cursor и ChatGPT. Смотрю Яндекс Метрику. Делаю сверки и отчёты в Excel.";
    const analysis = parseModelOutput(
      JSON.stringify({
        matchExplanation: "Инструменты и данные уже есть.",
        covered: [
          { requirement: "AI-инструменты", evidence: "Cursor и ChatGPT" },
          { requirement: "продуктовые метрики", evidence: "Яндекс Метрику" },
          { requirement: "работа с данными", evidence: "сверки и отчёты" },
          { requirement: "", evidence: "" },
        ],
        gaps: [],
        fixes: [
          fix("Веду задачи в Cursor и ChatGPT", "Веду задачи в Cursor и ChatGPT для работы"),
          fix("Смотрю Яндекс Метрику", "Смотрю продуктовые метрики в Яндекс Метрике"),
          fix("Делаю сверки и отчёты в Excel", "Делаю сверки и отчёты в Excel по данным"),
        ],
      }),
      sample,
      ["AI-инструменты", "продуктовые метрики", "работа с данными", "коммуникабельность"],
    );
    assert.deepEqual(
      analysis.covered.map((item) => item.requirement),
      ["AI-инструменты", "продуктовые метрики", "работа с данными"],
    );
    assert.deepEqual(
      analysis.gaps.map((item) => item.requirement),
      ["коммуникабельность"],
    );
    assert.equal(analysis.matchPercent, 75);
  });

  it("rejects prose instead of json and logs the rule", () => {
    const lines: string[] = [];
    const previous = console.error;
    console.error = (message?: unknown) => {
      lines.push(String(message));
    };
    try {
      assert.throws(
        () => parseModelOutput("Вот общий совет: улучшите резюме.", resume),
        (error: unknown) =>
          error instanceof AnalyzeError &&
          error.retryable &&
          error.message.includes("неожиданном виде"),
      );
    } finally {
      console.error = previous;
    }
    assert.match(lines.join("\n"), /not json/);
    assert.equal(lines.join("\n").includes("Bearer"), false);
  });
});

describe("readRequirementList", () => {
  it("reads a fenced array and drops blanks and duplicates", () => {
    assert.deepEqual(
      readRequirementList('```json\n["AI-инструменты"," AI-инструменты ","","работа с данными"]\n```'),
      ["AI-инструменты", "работа с данными"],
    );
    assert.deepEqual(readRequirementList('{"requirements":["Excel"]}'), ["Excel"]);
  });
});

describe("textIncludesQuote", () => {
  it("folds case, ё and trailing punctuation", () => {
    assert.equal(normalize("  Вёл   учёт. "), "вел учет");
    assert.equal(textIncludesQuote("Python", resume), true);
    assert.equal(textIncludesQuote("Go", resume), false);
    assert.equal(textIncludesQuote("Вёл учёт склада в 1С.", resume), true);
    assert.equal(textIncludesQuote("учет   склада в 1С!!!", resume), true);
  });
});
