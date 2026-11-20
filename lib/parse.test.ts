import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnalyzeError } from "./errors.ts";
import {
  assembleFixes,
  normalize,
  parseModelOutput,
  readRequirementList,
  rejectFix,
  textIncludesQuote,
} from "./parse.ts";

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
    assert.equal(analysis.fixes.length, 1);
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
    assert.equal(analysis.gaps.map((item) => item.requirement).join(","), "SQL,Excel");
    assert.equal(analysis.fixes.some((item) => item.before.includes("30%")), false);
    assert.equal(analysis.fixes.some((item) => item.before.includes("бакалавриат")), false);
    assert.equal(analysis.matchPercent, 33);
  });

  it("keeps the checklist when every fix is invented", () => {
    const analysis = parseModelOutput(
      payload({
        matchExplanation: "Резюме соответствует требованиям на 100%.",
        fixes: [
          fix("Сократил время на 30%", "Сократил время"),
          fix("Вырос доход отдела", "Доход отдела вырос"),
        ],
      }),
      resume,
    );
    assert.equal(analysis.fixes.length, 0);
    assert.equal(analysis.matchPercent > 0, true);
    assert.doesNotMatch(analysis.matchExplanation, /соответствует/i);
  });

  it("drops the empty placeholder covered item from the live payload", () => {
    const live =
      '{"matchPercent":0,"matchExplanation":"Нет пересечения опыта и навыков кандидата с требованиями вакансии.","covered":[{"requirement":"","evidence":""}],"gaps":[{"requirement":"опыт с данными"}],"fixes":[{"before":"вел учет склада в 1С","after":"Вёл учёт склада в 1С","why":"Так требование видно сразу."},{"before":"Писал скрипты на Python для остатков","after":"Писал скрипты на Python для учёта остатков","why":"Яснее."},{"before":"Окончил бакалавриат по экономике","after":"Бакалавриат по экономике","why":"Короче."}]}';
    const analysis = parseModelOutput(live, resume);
    assert.equal(analysis.covered.length, 1);
    assert.equal(analysis.matchPercent, 100);
    assert.equal(analysis.fixes.length, 1);
    assert.match(analysis.matchExplanation, /Закрыто 1 из 1/);
    assert.doesNotMatch(analysis.matchExplanation, /нет пересечения|соответствует/i);
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

describe("matchRequirement", () => {
  const market =
    "В СберМаркетинг делала сверки размещений и отчёты по радио и прессе, работала с подрядчиками. В агентстве «Находка» 56 платящих клиентов и 185 заявок, аудит карточек по чек-листу. Пользуюсь Cursor и ChatGPT для прототипов и текстов. Настраивала Яндекс Метрику.";

  it("counts Metrika, reports and an agency with clients", () => {
    const analysis = parseModelOutput(
      JSON.stringify({
        matchExplanation: "Резюме соответствует требованиям, нет закрытых пунктов.",
        covered: [{ requirement: "AI-инструменты", evidence: "нет такой цитаты" }],
        gaps: [
          { requirement: "MVP" },
          { requirement: "Продуктовые метрики и аналитика" },
          { requirement: "работа с данными" },
          { requirement: "Свой проект, стартап или пет-проект с реальными пользователями" },
        ],
        fixes: [
          fix("Настраивала Яндекс Метрику", "запускала MVP и веду аналитику продуктовых метрик и показателей эффективности рекламных кампаний"),
          fix("В агентстве «Находка» 56 платящих клиентов и 185 заявок", "достигнута высокая эффективность"),
          fix("Пользуюсь Cursor и ChatGPT для прототипов и текстов", "Разработала и внедрила Cursor и ChatGPT"),
          fix("Настраивала Яндекс Метрику", "Настраивала Яндекс Метрику для продуктовых метрик"),
        ],
      }),
      market,
      [
        "AI-инструменты",
        "MVP",
        "Продуктовые метрики и аналитика",
        "работа с данными",
        "Свой проект, стартап или пет-проект с реальными пользователями",
      ],
    );
    assert.deepEqual(
      analysis.covered.map((item) => item.requirement),
      [
        "AI-инструменты",
        "Продуктовые метрики и аналитика",
        "работа с данными",
        "Свой проект, стартап или пет-проект с реальными пользователями",
      ],
    );
    assert.deepEqual(analysis.gaps.map((item) => item.requirement), ["MVP"]);
    assert.equal(analysis.matchPercent, 80);
    assert.match(analysis.matchExplanation, /Закрыто 4 из 5/);
    assert.equal(analysis.fixes.length, 1);
    assert.match(analysis.fixes[0].after, /Яндекс Метрику/);
    assert.match(analysis.covered[3].evidence, /56 платящих/);
  });

  it("drops fixes that add facts, claims or lose numbers", () => {
    const sample = "В агентстве «Находка» 56 платящих клиентов. Пользуюсь Cursor и ChatGPT.";
    assert.equal(
      rejectFix(fix("Пользуюсь Cursor и ChatGPT", "запускала MVP"), sample, ["AI-инструменты"]),
      "new claim запускала",
    );
    assert.match(
      rejectFix(
        fix("Пользуюсь Cursor и ChatGPT", "веду аналитику продуктовых метрик и показателей эффективности рекламных кампаний"),
        sample,
        ["продуктовые метрики"],
      ) ?? "",
      /new word/,
    );
    assert.match(
      rejectFix(fix("Пользуюсь Cursor и ChatGPT", "достигнута высокая эффективность"), sample, []) ?? "",
      /cliche|new claim/,
    );
    assert.match(
      rejectFix(fix("Пользуюсь Cursor и ChatGPT", "Разработала и внедрила"), sample, []) ?? "",
      /new claim/,
    );
    assert.equal(
      rejectFix(
        fix("В агентстве «Находка» 56 платящих клиентов", "В агентстве «Находка» много клиентов"),
        sample,
        [],
      ),
      "dropped number",
    );
    assert.equal(
      rejectFix(fix("этого фрагмента нет в резюме вообще", "Другая строка про опыт"), sample, []),
      "before not in resume",
    );
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

describe("assembleFixes", () => {
  const resume =
    "Анастасия Косолапова. Студентка 3 курса РУДН, направление «Реклама и связи с общественностью». С сентября 2026 года младший эксперт по закупке медиа в СберМаркетинге: сверки размещений, отчёты по радио и прессе, работа с подрядчиками. Основала агентство «Находка»: аудит карточек бизнеса в Яндекс Картах по чек-листу, готовые правки. Пользуюсь Cursor и ChatGPT для прототипов и текстов, настраивала Яндекс Метрику на сайте агентства.";
  const vacancy =
    "Junior AI Product Manager в Changellenge. Требования: опыт работы с AI-инструментами (ChatGPT, Cursor и др.); понимание продуктовых метрик и аналитики; умение работать с данными; опыт запуска MVP или прототипов; знание SQL; английский язык на уровне B2; коммуникабельность и умение работать с командой.";
  const requirements = [
    "опыт работы с AI-инструментами",
    "понимание продуктовых метрик и аналитики",
    "умение работать с данными",
    "опыт запуска MVP или прототипов",
    "знание SQL",
    "английский язык на уровне B2",
    "коммуникабельность и умение работать с командой",
  ];
  const badModel = JSON.stringify({
    fixes: [
      fix("Пользуюсь Cursor и ChatGPT для прототипов и текстов", "запускала MVP на Cursor и ChatGPT"),
      fix(
        "настраивала Яндекс Метрику на сайте агентства",
        "веду аналитику продуктовых метрик и показателей эффективности рекламных кампаний",
      ),
      fix("Основала агентство «Находка»", "Разработала и внедрила агентство «Находка»"),
      fix("этой строки в резюме нет", "Другая биография"),
    ],
  });

  it("does not invent shuffled lines when the model fixes are rejected", () => {
    const lines: string[] = [];
    const previous = console.error;
    console.error = (message?: unknown) => {
      lines.push(String(message));
    };
    try {
      const fixes = assembleFixes(resume, vacancy, requirements, [], [badModel]);
      assert.equal(fixes.length, 0);
    } finally {
      console.error = previous;
    }
    const log = lines.join("\n");
    assert.match(log, /drop fix new claim/);
    assert.equal(log.includes("parse fixes local"), false);
    assert.equal(log.includes("Косолапова"), false);
  });

  it("keeps a real rewrite and drops a shuffle, MVP and a student line", () => {
    assert.equal(
      rejectFix(
        fix(
          "Пользуюсь Cursor и ChatGPT для прототипов и текстов",
          "Делаю прототипы в Cursor и пишу тексты с ChatGPT",
        ),
        resume,
        requirements,
        vacancy,
      ),
      null,
    );
    assert.equal(
      rejectFix(
        fix(
          "сверки размещений, отчёты по радио и прессе",
          "Сверяю данные по размещениям и готовлю отчёты по радио и прессе",
        ),
        resume,
        requirements,
        vacancy,
      ),
      null,
    );
    assert.equal(
      rejectFix(
        fix("Пользуюсь Cursor и ChatGPT для прототипов и текстов", "запускала MVP на Cursor и ChatGPT"),
        resume,
        requirements,
        vacancy,
      ),
      "new claim запускала",
    );
    assert.equal(
      rejectFix(
        fix(
          "настраивала Яндекс Метрику на сайте агентства",
          "На сайте агентства настраивала Яндекс Метрику",
        ),
        resume,
        requirements,
        vacancy,
      ),
      "shuffle",
    );
    assert.equal(
      rejectFix(
        fix(
          "Студентка 3 курса РУДН, направление «Реклама и связи с общественностью»",
          "Направление «Реклама и связи с общественностью», студентка 3 курса РУДН",
        ),
        resume,
        requirements,
        vacancy,
      ),
      "shuffle",
    );
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
