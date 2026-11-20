import { AnalyzeError } from "./errors.ts";

export type MatchStatus = "covered" | "partial" | "gap";

export type Analysis = {
  matchPercent: number;
  matchExplanation: string;
  covered: { requirement: string; evidence: string }[];
  partial: { requirement: string; evidence: string }[];
  gaps: { requirement: string }[];
  fixes: { before: string; after: string; why: string }[];
};

const BAD_SHAPE = "Модель вернула ответ в неожиданном виде. Попробуйте ещё раз.";

export function normalize(text: string): string {
  return text
    .replace(/[*_#]+/g, "")
    .replace(/[•·▪‣]/g, " ")
    .replace(/[«»“”„"]/g, "")
    .replace(/[–—−-]/g, " ")
    .replace(/ё/gi, "е")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?…]+$/u, "")
    .trim()
    .toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ponytail: normalized substring, trailing punctuation stripped. Not a fuzzy match.
export function textIncludesQuote(quote: string, source: string): boolean {
  const needle = normalize(quote);
  const haystack = normalize(source);
  if (!needle) return false;
  if (needle.length >= 12) return haystack.includes(needle);
  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?:$|[^\\p{L}\\p{N}_])`,
    "u",
  );
  return pattern.test(haystack);
}

function balancedSlice(text: string): string | null {
  const objAt = text.indexOf("{");
  const arrAt = text.indexOf("[");
  if (objAt < 0 && arrAt < 0) return null;
  const start = objAt < 0 ? arrAt : arrAt < 0 ? objAt : Math.min(objAt, arrAt);
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? trimmed).trim();
  const candidates = [raw, balancedSlice(raw), balancedSlice(trimmed)].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next candidate
    }
  }
  throw new SyntaxError("not json");
}

function logParse(rule: string, snippet: string) {
  const body = snippet.replace(/\s+/g, " ").trim().slice(0, 180);
  console.error(`parse ${rule} body ${body}`);
}

const GENERIC_STEMS = new Set([
  "работ",
  "опыт",
  "навык",
  "требо",
  "умени",
  "челов",
  "нужен",
  "владе",
  "спосо",
  "уровн",
  "высок",
  "хорош",
  "отлич",
  "профе",
  "знани",
  "инстру",
  "польз",
]);

const CLAIM_STEMS = ["запус", "разра", "внедр", "дости", "эффек", "высок", "оптим", "увелич", "сократ", "рост"];
const LIGHT_STEMS = /^(дела|веду|вела|наст|пишу|писа|смотр|рабо|исп|поль|помо|зани|отве|гото|пров|соби|свер|сост|анал)/;
const TITLE_STEMS = ["менед", "директ", "руковод", "продакт", "junior", "senior"];

const CLICHE = /имеется опыт|осуществля|достигнут|высокая эффективность/;

function textHasStem(text: string, stem: string): boolean {
  const hay = normalize(text);
  if (hay.includes(stem)) return true;
  const prefix = stem.slice(0, 4);
  return prefix.length >= 4 && hay.includes(prefix);
}

function stemsOf(text: string): string[] {
  const tokens = normalize(text).split(/[^a-zа-я0-9]+/i).filter(Boolean);
  const stems: string[] = [];
  for (const token of tokens) {
    if (token.length >= 5) stems.push(token.slice(0, 5));
    else if (token.length >= 2 && /[a-z0-9]/i.test(token) && !/^[а-я]+$/i.test(token)) stems.push(token);
  }
  return [...new Set(stems)];
}

export type ResumeLine = { id: string; text: string };

export function resumeLines(resume: string): ResumeLine[] {
  const plain = resume.replace(/[*_#]+/g, "").replace(/[•·▪‣]/g, "\n");
  const parts = plain
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 12);
  const rows = parts.length ? parts : [plain.replace(/\s+/g, " ").trim()].filter(Boolean);
  return rows.map((text, index) => ({ id: `L${index + 1}`, text }));
}

export function linesForPrompt(resume: string, vacancy: string, evidence: string[] = []): ResumeLine[] {
  const lines = resumeLines(resume);
  if (lines.length <= 16) return lines;
  const hints = `${vacancy}\n${evidence.join("\n")}`;
  const scored = lines.map((line) => ({
    line,
    score: stemsOf(line.text).filter((stem) => !GENERIC_STEMS.has(stem) && textHasStem(hints, stem)).length,
  }));
  const picked = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 18);
  return (picked.length >= 4 ? picked : scored.slice(0, 12)).map((item) => item.line);
}

function sentences(resume: string): string[] {
  const parts = resume
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12);
  return parts.length ? parts : [resume.trim()].filter(Boolean);
}

function quoteFor(resume: string, needles: string[]): string | null {
  const wanted = needles.map((needle) => normalize(needle)).filter(Boolean);
  if (!wanted.length) return null;
  for (const sentence of sentences(resume)) {
    const hay = normalize(sentence);
    if (wanted.some((needle) => hay.includes(needle))) return sentence.slice(0, 500);
  }
  const hay = normalize(resume);
  if (wanted.some((needle) => hay.includes(needle))) return resume.trim().slice(0, 500);
  return null;
}

export function matchRequirement(
  resume: string,
  requirement: string,
): { status: MatchStatus; evidence: string } {
  const req = normalize(requirement);
  const src = normalize(resume);
  const direct = stemsOf(requirement).filter((stem) => !GENERIC_STEMS.has(stem) && src.includes(stem));
  if (direct.length) {
    const evidence = quoteFor(resume, direct);
    if (evidence) return { status: "covered", evidence };
  }

  const asksAi = stemsOf(requirement).includes("ai") || /(?:^|[^а-я])ии(?:$|[^а-я])|нейро/.test(req);
  if (asksAi && /chatgpt|cursor|нейро|\bgpt\b/.test(src)) {
    const evidence = quoteFor(resume, ["chatgpt", "cursor", "gpt", "нейро"]);
    if (evidence) return { status: "covered", evidence };
  }

  if (/данн/.test(req) && /сверк|отчет|excel|таблиц|учет/.test(src)) {
    const evidence = quoteFor(resume, ["сверк", "отчет", "отчёт", "excel", "таблиц", "учет", "учёт"]);
    if (evidence) return { status: "covered", evidence };
  }

  const asksProject = /проект|стартап|пет-проект|пользовател/.test(req);
  const ownThing = /агентств|стартап|свое дело|свой бизнес/.test(src);
  const hasUsers = /клиент|платя|заявк|пользовател/.test(src);
  if (asksProject && ownThing && hasUsers) {
    const evidence = quoteFor(resume, ["клиент", "платя", "заявк", "агентств", "стартап"]);
    if (evidence) return { status: "covered", evidence };
  }

  if (/коммуника|общен/.test(req)) {
    if (/коммуника|общен|переговор|презентац/.test(src)) {
      const evidence = quoteFor(resume, ["коммуника", "общен", "переговор", "презентац"]);
      if (evidence) return { status: "covered", evidence };
    }
    if (/подрядчик|команд/.test(src)) {
      const evidence = quoteFor(resume, ["подрядчик", "команд"]);
      if (evidence) return { status: "partial", evidence };
    }
  }

  return { status: "gap", evidence: "" };
}

export function explainMatch(covered: number, partial: number, total: number): string {
  if (total === 0) return "В вакансии не нашлось отдельных требований.";
  if (covered === 0 && partial === 0) return "По резюме эти требования не подтверждаются.";
  const partialNote = partial ? `, частично ${partial}` : "";
  return `Закрыто ${covered} из ${total}${partialNote}.`;
}

export function buildAnalysis(
  resume: string,
  requirements: string[],
  fixes: { before: string; after: string; why: string }[],
): Analysis {
  const covered: Analysis["covered"] = [];
  const partial: Analysis["partial"] = [];
  const gaps: Analysis["gaps"] = [];
  for (const requirement of requirements) {
    const match = matchRequirement(resume, requirement);
    if (match.status === "covered") covered.push({ requirement, evidence: match.evidence });
    else if (match.status === "partial") partial.push({ requirement, evidence: match.evidence });
    else gaps.push({ requirement });
  }
  const total = requirements.length;
  const matchPercent =
    total === 0 ? 0 : Math.round((100 * (covered.length + 0.5 * partial.length)) / total);
  return {
    matchPercent,
    matchExplanation: explainMatch(covered.length, partial.length, total).slice(0, 280),
    covered,
    partial,
    gaps,
    fixes: fixes.slice(0, 3),
  };
}

export function rejectFix(
  fix: { before: string; after: string; why: string },
  resume: string,
  requirements: string[],
  vacancy = "",
): string | null {
  const before = fix.before.trim();
  const after = fix.after.trim();
  if (!normalize(before) || !normalize(resume).includes(normalize(before))) return "before not in resume";
  if (before.replace(/\s+/g, " ").trim().toLowerCase() === after.replace(/\s+/g, " ").trim().toLowerCase()) {
    return "unchanged";
  }
  if (tokenBag(before) === tokenBag(after)) return "shuffle";
  if (CLICHE.test(normalize(after))) return "cliche";
  for (const num of before.match(/\d+/g) ?? []) {
    if (!after.includes(num)) return "dropped number";
  }
  for (const num of after.match(/\d+/g) ?? []) {
    if (!resume.includes(num)) return `new number ${num}`;
  }
  const allowedText = `${requirements.join(" ")}\n${vacancy}`;
  for (const token of normalize(after).split(/[^a-zа-я0-9]+/i).filter(Boolean)) {
    const latin = /[a-z]/i.test(token);
    const significant = token.length >= 5 || (token.length >= 2 && latin);
    if (!significant) continue;
    const stem = token.length >= 5 ? token.slice(0, 5) : token;
    const known = textHasStem(resume, stem) || textHasStem(before, stem);
    if (latin && !known) return `new tool ${token}`;
    if (CLAIM_STEMS.some((prefix) => stem.startsWith(prefix)) && !known) return `new claim ${token}`;
    if (TITLE_STEMS.some((prefix) => stem.startsWith(prefix)) && !textHasStem(resume, stem)) {
      return `title change ${token}`;
    }
    if (known || LIGHT_STEMS.test(stem) || textHasStem(allowedText, stem)) continue;
    return `new word ${token}`;
  }
  if (requirements.length && !linkedRequirement(`${before} ${after}`, requirements)) return "off vacancy";
  return null;
}

function tokenBag(text: string): string {
  return normalize(text)
    .split(/[^a-zа-я0-9]+/i)
    .filter((token) => token.length >= 4)
    .sort()
    .join(" ");
}

const BRIDGES: { line: string[]; req: string[] }[] = [
  { line: ["сверк", "отчет", "учет", "табли"], req: ["данн"] },
  { line: ["метри"], req: ["метри", "аналит"] },
  { line: ["cursor", "chatgpt", "gpt", "прото"], req: ["ai", "прото", "инстру"] },
  { line: ["подряд"], req: ["комму", "коман"] },
];

function touchesRequirement(text: string, requirement: string): boolean {
  const stems = stemsOf(requirement).filter((stem) => !GENERIC_STEMS.has(stem));
  if (stems.some((stem) => textHasStem(text, stem))) return true;
  const line = normalize(text);
  const req = normalize(requirement);
  return BRIDGES.some(
    (bridge) => bridge.line.some((stem) => line.includes(stem)) && bridge.req.some((stem) => req.includes(stem)),
  );
}

export function linkedRequirement(
  text: string,
  requirements: string[],
): string | null {
  let best: { requirement: string; score: number } | null = null;
  for (const requirement of requirements) {
    if (!touchesRequirement(text, requirement)) continue;
    const score = stemsOf(requirement).filter((stem) => textHasStem(text, stem)).length + 1;
    if (!best || score > best.score) best = { requirement, score };
  }
  return best?.requirement ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trim();
}

function requirementTexts(value: unknown): string[] {
  const rows = Array.isArray(value) ? value : [];
  const items: string[] = [];
  for (const item of rows) {
    const requirement = textField(typeof item === "string" ? item : asRecord(item)?.requirement, 300);
    if (requirement) items.push(requirement);
  }
  return items;
}

export function rawModelFixes(text: string): { before: string; after: string; why: string }[] {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return [];
  }
  const obj = asRecord(raw);
  const rows = Array.isArray(raw) ? raw : Array.isArray(obj?.fixes) ? obj.fixes : [];
  return rows.flatMap((item) => {
    const row = asRecord(item);
    const before = textField(row?.before, 500) ?? textField(row?.lineId, 12) ?? "";
    const after = textField(row?.after, 500) ?? "";
    const why = textField(row?.why, 300) ?? "";
    if (!before && !after && !why) return [];
    return [{ before, after, why }];
  });
}

export function readFixes(
  text: string,
  resume: string,
  requirements: string[],
  vacancy = "",
  quiet = false,
): {
  fixes: { before: string; after: string; why: string }[];
  reasons: string[];
  dropped: { before: string; after: string; why: string; reason: string }[];
} {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    logParse("not json", text);
    throw new AnalyzeError(502, BAD_SHAPE, true);
  }
  const obj = asRecord(raw);
  const rows = Array.isArray(raw) ? raw : Array.isArray(obj?.fixes) ? obj.fixes : [];
  const fixes: { before: string; after: string; why: string }[] = [];
  const reasons: string[] = [];
  const dropped: { before: string; after: string; why: string; reason: string }[] = [];
  for (const item of rows) {
    const row = asRecord(item);
    const lineId = textField(row?.lineId, 12);
    const line = lineId
      ? resumeLines(resume).find((item) => item.id.toLowerCase() === lineId.toLowerCase())
      : undefined;
    const before = line ? line.text : textField(row?.before, 500);
    const after = textField(row?.after, 500);
    const why = textField(row?.why, 300) ?? (textField(row?.requirement, 300) ? "Правка." : null);
    const source = line ? line.text : resume;
    if (lineId && !line) {
      if (!quiet) console.error(`parse drop fix unknown line ${lineId}`);
      reasons.push(`unknown line ${lineId}`);
      dropped.push({
        before: before ?? lineId,
        after: after ?? "",
        why: why ?? "",
        reason: `unknown line ${lineId}`,
      });
      continue;
    }
    if (!before || !after || !why) {
      if (!quiet) console.error("parse drop fix empty");
      reasons.push("empty");
      dropped.push({ before: before ?? "", after: after ?? "", why: why ?? "", reason: "empty" });
      continue;
    }
    const reason = rejectFix({ before, after, why }, source, requirements, vacancy);
    if (reason) {
      if (!quiet) console.error(`parse drop fix ${reason}`);
      reasons.push(reason);
      dropped.push({ before, after, why, reason });
      continue;
    }
    const linked = linkedRequirement(`${before} ${after}`, requirements);
    const named =
      linked && !touchesRequirement(why, linked)
        ? `Ближе к требованию «${linked}».`
        : why;
    fixes.push({ before, after, why: named.slice(0, 300) });
  }
  return { fixes: fixes.slice(0, 8), reasons, dropped };
}

export function readRequirementList(text: string): string[] {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return [];
  }
  const list = Array.isArray(raw)
    ? raw
    : asRecord(raw) && Array.isArray(asRecord(raw)?.requirements)
      ? (asRecord(raw)?.requirements as unknown[])
      : [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of list) {
    const requirement = textField(item, 300);
    const key = requirement ? normalize(requirement) : "";
    if (!requirement || !key || seen.has(key)) continue;
    seen.add(key);
    items.push(requirement);
  }
  return items.slice(0, 12);
}

function inferRequirements(text: string): string[] {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return [];
  }
  const obj = asRecord(raw);
  const seen = new Set<string>();
  const items: string[] = [];
  for (const requirement of [
    ...requirementTexts(obj?.covered),
    ...requirementTexts(obj?.partial),
    ...requirementTexts(obj?.gaps),
  ]) {
    const key = normalize(requirement);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(requirement);
  }
  return items.slice(0, 12);
}

export function assembleFixes(
  resume: string,
  vacancy: string,
  requirements: string[],
  accepted: { before: string; after: string; why: string }[],
  modelTexts: string[],
): { before: string; after: string; why: string }[] {
  const fixes = [...accepted];
  for (const text of modelTexts) {
    let more: { before: string; after: string; why: string }[] = [];
    try {
      more = readFixes(text, resume, requirements, vacancy).fixes;
    } catch (error) {
      console.error(`parse fixes refill ${error instanceof Error ? error.message : "error"}`);
      continue;
    }
    for (const fix of more) {
      if (fixes.some((item) => normalize(item.before) === normalize(fix.before))) continue;
      fixes.push(fix);
    }
  }
  console.error(`parse fixes kept ${Math.min(fixes.length, 3)}`);
  return fixes.slice(0, 3);
}

export function parseModelOutput(
  text: string,
  resume: string,
  requirements: string[] = [],
  vacancy = "",
): Analysis {
  const list = requirements.length ? requirements : inferRequirements(text);
  const fixes = readFixes(text, resume, list, vacancy).fixes;
  if (!list.length && !fixes.length) {
    logParse("empty checklist", text);
    throw new AnalyzeError(502, BAD_SHAPE, true);
  }
  return buildAnalysis(resume, list, fixes);
}
