"use client";

import { useRef, useState, type FormEvent } from "react";
import { YM_GOALS } from "@/lib/goals";
import { MAX_INPUT_CHARS, inputError } from "@/lib/limits";
import { reachGoal, trackResumeEntered } from "@/lib/metrika";
import type { Analysis } from "@/lib/parse";

export default function HomePage() {
  const [resume, setResume] = useState("");
  const [vacancy, setVacancy] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Analysis | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const invalid = inputError(resume, vacancy);
    if (invalid) {
      setError(invalid);
      setResult(null);
      return;
    }

    setLoading(true);
    setError("");
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
        Вставьте резюме и вакансию. Покажем совпадение, пробелы и три правки формулировок.
      </p>

      <form onSubmit={onSubmit} className="mt-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            id="resume"
            label="Резюме"
            value={resume}
            placeholder="Опыт, навыки, образование — как в резюме, обычным текстом."
            onChange={(value) => {
              setResume(value);
              trackResumeEntered(value);
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
            disabled={loading}
            className="inline-flex h-11 items-center justify-center rounded-md bg-stone-900 px-5 text-sm font-medium text-white disabled:opacity-60"
          >
            {loading ? "Разбираем…" : "Разобрать"}
          </button>
          <p className="text-sm text-stone-500">
            Правки только перефразируют то, что уже написано в резюме. Обычно это занимает до минуты.
          </p>
        </div>

        {error ? (
          <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
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
              {result.covered.length === 0 ? (
                <p className="mt-3 text-sm text-stone-600">Нет пунктов, которые уже закрыты.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {result.covered.map((item, index) => (
                    <li key={`${item.requirement}-${index}`} className="text-sm">
                      <p className="font-medium">{item.requirement}</p>
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
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const over = value.length > MAX_INPUT_CHARS;
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        spellCheck
        lang="ru"
        autoComplete="off"
        className="mt-1 min-h-64 w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2 text-base leading-relaxed outline-none focus:border-stone-500"
      />
      <p className={`mt-1 text-xs ${over ? "text-red-700" : "text-stone-400"}`}>
        {value.length} / {MAX_INPUT_CHARS}
      </p>
    </div>
  );
}
