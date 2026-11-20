"use client";

import { useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  ExtractError,
  MAX_RESUME_FILE_BYTES,
  RESUME_FILE_TOO_BIG,
  extractResumeText,
  extractedResumeError,
} from "@/lib/extract";
import { YM_GOALS } from "@/lib/goals";
import { MAX_INPUT_CHARS, inputError } from "@/lib/limits";
import { reachGoal, trackResumeEntered } from "@/lib/metrika";
import type { Analysis } from "@/lib/parse";

export default function HomePage() {
  const [resume, setResume] = useState("");
  const [vacancy, setVacancy] = useState("");
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [result, setResult] = useState<Analysis | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const readingRef = useRef(false);

  async function readResume(file: File) {
    if (readingRef.current) return;
    readingRef.current = true;
    setReading(true);
    setFileError("");
    setError("");
    try {
      if (file.size > MAX_RESUME_FILE_BYTES) {
        setFileError(RESUME_FILE_TOO_BIG);
        return;
      }
      const text = await extractResumeText(file.name, new Uint8Array(await file.arrayBuffer()));
      const problem = extractedResumeError(text);
      if (text.trim()) {
        setResume(text);
        trackResumeEntered(text);
        reachGoal(YM_GOALS.uploadResume);
      }
      setFileError(problem ?? "");
    } catch (caught) {
      setFileError(
        caught instanceof ExtractError
          ? caught.message
          : "Не удалось прочитать файл. Проверьте, что это PDF, DOCX или TXT.",
      );
    } finally {
      readingRef.current = false;
      setReading(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const invalid = inputError(resume, vacancy);
    if (invalid) {
      setFileError("");
      setError(invalid);
      setResult(null);
      return;
    }

    setLoading(true);
    setError("");
    setFileError("");
    setResult(null);
    setCopied(null);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume, vacancy }),
      });
      const data = (await response.json().catch(() => null)) as
        | (Analysis & { error?: string })
        | null;
      if (!response.ok) {
        setError(data?.error || "Не удалось получить разбор. Попробуйте ещё раз.");
        return;
      }
      if (!data || typeof data.matchPercent !== "number" || !Array.isArray(data.fixes)) {
        setError("Не удалось получить разбор. Попробуйте ещё раз.");
        return;
      }
      setResult(data);
      reachGoal(YM_GOALS.getAnalysis);
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch {
      setError("Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.");
    } finally {
      setLoading(false);
    }
  }

  async function copyFix(index: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      reachGoal(YM_GOALS.copyFix);
      window.setTimeout(() => {
        setCopied((current) => (current === index ? null : current));
      }, 2000);
    } catch {
      setError("Не удалось скопировать. Выделите текст «стало» и скопируйте вручную.");
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:py-12">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        Разбор резюме под вакансию
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-stone-600 sm:text-base">
        Вставьте резюме и вакансию или загрузите резюме файлом. Покажем совпадение, пробелы и
        три правки формулировок.
      </p>

      <form onSubmit={onSubmit} className="mt-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            id="resume"
            label="Резюме"
            value={resume}
            placeholder="Опыт, навыки, образование — как в резюме, обычным текстом."
            hint="PDF, DOCX или TXT, до 5 МБ"
            reading={reading}
            onFile={(file) => void readResume(file)}
            onChange={(value) => {
              setResume(value);
              trackResumeEntered(value);
              setFileError("");
            }}
          />
          <Field
            id="vacancy"
            label="Вакансия"
            value={vacancy}
            placeholder="Обязанности и требования из текста вакансии."
            onChange={setVacancy}
          />
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="submit"
            disabled={loading || reading}
            className="inline-flex h-11 items-center justify-center rounded-md bg-stone-900 px-5 text-sm font-medium text-white disabled:opacity-60"
          >
            {loading ? "Разбираем…" : "Разобрать"}
          </button>
          <p className="text-sm text-stone-500">
            Правки только перефразируют то, что уже написано в резюме. Обычно это занимает до минуты.
          </p>
        </div>

        {fileError || error ? (
          <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {fileError || error}
          </p>
        ) : null}
      </form>

      {result ? (
        <div ref={resultRef} className="mt-8 scroll-mt-6 space-y-6">
          <section className="rounded-lg border border-stone-200 bg-white p-4 sm:p-5">
            <h2 className="text-sm font-medium text-stone-500">Совпадение</h2>
            <p className="mt-1 text-4xl font-semibold tabular-nums">{result.matchPercent}%</p>
            <p className="mt-2 text-sm leading-relaxed text-stone-700">{result.matchExplanation}</p>
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-lg border border-stone-200 bg-white p-4 sm:p-5">
              <h2 className="text-sm font-medium text-stone-500">Уже есть в резюме</h2>
              {result.covered.length === 0 && result.partial.length === 0 ? (
                <p className="mt-3 text-sm text-stone-600">Нет пунктов, которые уже закрыты.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {result.covered.map((item, index) => (
                    <li key={`${item.requirement}-${index}`} className="text-sm">
                      <p className="font-medium">{item.requirement}</p>
                      <p className="mt-1 text-stone-600">«{item.evidence}»</p>
                    </li>
                  ))}
                  {result.partial.map((item, index) => (
                    <li key={`partial-${item.requirement}-${index}`} className="text-sm">
                      <p className="font-medium">
                        {item.requirement}{" "}
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                          частично
                        </span>
                      </p>
                      <p className="mt-1 text-stone-600">«{item.evidence}»</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-4 sm:p-5">
              <h2 className="text-sm font-medium text-stone-500">Не закрыто</h2>
              {result.gaps.length === 0 ? (
                <p className="mt-3 text-sm text-stone-600">Пустых требований не осталось.</p>
              ) : (
                <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
                  {result.gaps.map((item, index) => (
                    <li key={`${item.requirement}-${index}`}>{item.requirement}</li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {result.fixes.length > 0 ? (
          <section>
            <h2 className="text-sm font-medium text-stone-500">Правки формулировок</h2>
            <ol className="mt-3 space-y-3">
              {result.fixes.map((fix, index) => (
                <li key={`${fix.before}-${index}`} className="rounded-lg border border-stone-200 bg-white p-4 sm:p-5">
                  <p className="text-xs font-medium text-stone-500">Было</p>
                  <p className="mt-1 text-sm leading-relaxed">{fix.before}</p>
                  <p className="mt-3 text-xs font-medium text-stone-500">Стало</p>
                  <p className="mt-1 text-sm leading-relaxed">{fix.after}</p>
                  <p className="mt-3 text-sm text-stone-600">{fix.why}</p>
                  <button
                    type="button"
                    onClick={() => copyFix(index, fix.after)}
                    className="mt-3 inline-flex h-10 items-center rounded-md border border-stone-300 px-3 text-sm hover:bg-stone-50"
                  >
                    {copied === index ? "Скопировано" : "Скопировать"}
                  </button>
                </li>
              ))}
            </ol>
          </section>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function Field({
  id,
  label,
  value,
  placeholder,
  onChange,
  onFile,
  reading = false,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onFile?: (file: File) => void;
  reading?: boolean;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const over = value.length > MAX_INPUT_CHARS;

  function hasFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!onFile || reading || !hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOver(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!onFile) return;
    event.preventDefault();
    setDragOver(false);
    if (reading) return;
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  }

  return (
    <div onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="flex items-baseline justify-between gap-3 md:justify-start">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {onFile ? (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={reading}
              className="text-sm text-stone-500 underline decoration-stone-300 underline-offset-2 hover:text-stone-700 disabled:opacity-60"
            >
              {reading ? "Читаем файл…" : "Загрузить файл"}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
              className="hidden"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) onFile(file);
              }}
            />
          </>
        ) : null}
      </div>
      <textarea
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        spellCheck
        lang="ru"
        autoComplete="off"
        className={`mt-1 min-h-64 w-full resize-y rounded-md border px-3 py-2 text-base leading-relaxed outline-none focus:border-stone-500 ${
          dragOver ? "border-dashed border-stone-900 bg-stone-50" : "border-stone-300 bg-white"
        }`}
      />
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs md:justify-start">
        <p className={over ? "text-red-700" : "text-stone-400"}>
          {value.length} / {MAX_INPUT_CHARS}
        </p>
        {hint ? <p className="text-stone-400">{dragOver ? "Отпустите файл" : hint}</p> : null}
      </div>
    </div>
  );
}
