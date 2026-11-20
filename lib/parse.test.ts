import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnalyzeError } from "./errors.ts";
import {
  assembleFixes,
  isJunkLine,
  normalize,
  parseModelOutput,
  readFixes,
  readRequirementList,
  rejectFix,
  resumeLines,
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

describe("lineId fixes", () => {
  const resume =
    "Сверки размещений, отчёты по радио и прессе. Пользуюсь Cursor и ChatGPT для прототипов и текстов.";
  const vacancy =
    "Нужен опыт AI-инструментов, прототипов, работы с данными. Нельзя приписывать чужие инструменты.";
  const requirements = ["умение работать с данными", "опыт работы с AI-инструментами"];

  it("drops invented lines and AI added to a reconciliation line", () => {
    const lines = resumeLines(resume);
    assert.equal(lines[0]?.id, "L1");
    assert.match(lines[0]?.text ?? "", /Сверки/);
    const raw = JSON.stringify({
      fixes: [
        {
          lineId: "L99",
          requirement: "данные",
          after: "Использую Python и SQL для анализа данных",
          why: "Так виден анализ.",
        },
        {
          lineId: "L1",
          requirement: "работа с данными",
          after: "Создавала и оптимизировала рекламные кампании в TikTok и Google Ads",
          why: "Сильнее.",
        },
        {
          lineId: "L1",
          requirement: "работа с данными",
          after: "Повышала конверсию отдела на 15%",
          why: "Цифра.",
        },
        {
          lineId: "L1",
          requirement: "работа с данными",
          after: "Сверки размещений с помощью AI-инструментов и прототипы",
          why: "Ближе к AI.",
        },
        {
          lineId: "L1",
          requirement: "умение работать с данными",
          after: "Сверяю данные по размещениям и готовлю отчёты по радио и прессе",
          why: "Факт виден сразу.",
        },
        {
          lineId: "L2",
          requirement: "опыт работы с AI-инструментами",
          after: "Делаю прототипы в Cursor и пишу тексты с ChatGPT",
          why: "Инструменты уже в строке.",
        },
      ],
    });
    const review = readFixes(raw, resume, requirements, vacancy, true);
    assert.deepEqual(
      review.reasons,
      review.dropped.map((item) => item.reason),
    );
    assert.equal(review.reasons.some((reason) => reason.startsWith("unknown line")), true);
    assert.equal(review.reasons.some((reason) => /tiktok|new tool|new claim/i.test(reason)), true);
    assert.equal(review.reasons.some((reason) => reason.includes("15")), true);
    assert.equal(review.reasons.some((reason) => /new tool ai/i.test(reason)), true);
    assert.equal(review.fixes.length, 2);
    assert.match(review.fixes[0]?.before ?? "", /Сверки размещений/);
    assert.match(review.fixes[1]?.before ?? "", /Cursor и ChatGPT/);
    assert.equal(review.fixes.some((item) => /AI-инструментов|15%|TikTok/i.test(item.after)), false);
  });
});

describe("fix filter edges", () => {
  const line = "С сентября 2026 года вела сверки размещений и готовила отчёты. Привлекла 1\u00a0500+ заявок параллельно.";
  const requirements = ["умение работать с данными"];

  it("drops junk lines and keeps a real sentence", () => {
    const resume = [
      "> под вакансию.",
      "Ничего не выдумываем — всё ниже подтверждено текстом резюме.",
      "# Опыт",
      "Москва | Telegram | телефон | email user@mail.ru",
      line,
    ].join("\n");
    assert.equal(isJunkLine("> под вакансию."), true);
    assert.equal(isJunkLine("Ничего не выдумываем — всё ниже подтверждено текстом резюме."), true);
    assert.equal(isJunkLine("# Опыт работы в компании"), true);
    assert.equal(isJunkLine("Москва | Telegram | телефон | email user@mail.ru"), true);
    const lines = resumeLines(resume);
    assert.equal(lines.length, 1);
    assert.match(lines[0]?.text ?? "", /сверки размещений/);
  });

  it("accepts 1500, a dropped year, verbal nouns and a word from the same line", () => {
    assert.equal(
      rejectFix(
        fix("Привлекла 1 500+ заявок", "1500 заявок привлекла по данным"),
        "Привлекла 1\u00a0500+ заявок",
        requirements,
        "работа с данными",
      ),
      null,
    );
    assert.equal(
      rejectFix(
        fix(
          "С сентября 2026 года вела сверки размещений и отчёты по радио",
          "Веду сверки размещений и готовлю отчёты по радио и данным",
        ),
        "С сентября 2026 года вела сверки размещений и отчёты по радио",
        requirements,
        "работа с данными",
      ),
      null,
    );
    assert.equal(
      rejectFix(
        fix("Пользуюсь Cursor для прототипов и текстов", "Для создания прототипов и написания текстов пользуюсь Cursor"),
        "Пользуюсь Cursor для прототипов и текстов",
        ["опыт работы с AI-инструментами"],
        "AI-инструменты, прототипы",
      ),
      null,
    );
    const resume = "Вела сверки размещений параллельно с коллегами.\nПользуюсь Cursor и ChatGPT для прототипов и текстов каждый день.";
    const review = readFixes(
      JSON.stringify({
        fixes: [
          {
            lineId: "L1",
            requirement: "умение работать с данными",
            after: "Параллельно веду сверки размещений по данным",
            why: "Факт виден сразу.",
          },
          {
            lineId: "L2",
            requirement: "данные",
            after: "Параллельно веду сверки размещений",
            why: "Нет.",
          },
        ],
      }),
      resume,
      requirements,
      "работа с данными",
      true,
    );
    assert.equal(review.fixes.length, 1);
    assert.match(review.fixes[0]?.before ?? "", /параллельно/);
    assert.equal(review.reasons.some((reason) => reason.startsWith("new word парал")), true);
  });

  it("drops a tense-only rewrite and an unrelated after", () => {
    assert.equal(
      rejectFix(
        fix("Закрывала отчёты по радио и прессе", "Закрываю отчёты по радио и прессе"),
        "Закрывала отчёты по радио и прессе",
        requirements,
        "работа с данными",
      ),
      "tense",
    );
    assert.equal(
      rejectFix(
        fix("Сверки размещений, отчёты по радио и прессе", "Готовлю аналитику данных для команды"),
        "Сверки размещений, отчёты по радио и прессе",
        requirements,
        "работа с данными, аналитика и команда",
      ),
      "unrelated",
    );
    assert.equal(
      rejectFix(
        fix("Повышала конверсию отдела на 15%", "Повышаю конверсию отдела"),
        "Повышала конверсию отдела на 15%",
        requirements,
        "работа с данными",
      ),
      "dropped number",
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

  it("matches a quote when the resume has markdown, bullets and dashes", () => {
    const marked = "**Пользуюсь** Cursor и ChatGPT\n- для прототипов и текстов\nсверки — отчёты";
    assert.equal(normalize(marked).includes("пользуюсь cursor и chatgpt для прототипов и текстов"), true);
    assert.equal(normalize(marked).includes("сверки отчеты"), true);
    assert.equal(
      rejectFix(
        fix(
          "Пользуюсь Cursor и ChatGPT для прототипов и текстов",
          "Делаю прототипы в Cursor и пишу тексты с ChatGPT",
        ),
        marked,
        ["опыт работы с AI-инструментами"],
        "AI-инструменты, прототипы",
      ),
      null,
    );
  });
});
