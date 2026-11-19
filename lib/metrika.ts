import { YM_GOALS, type YmGoal } from "@/lib/goals";

declare global {
  interface Window {
    ym?: (counterId: number, method: string, ...args: unknown[]) => void;
  }
}

const PASTE_FLAG = "ym_paste_resume";
let pasteTracked = false;

function counterId(): number | null {
  const raw = process.env.NEXT_PUBLIC_YM_ID?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/** Returns false when a counter is configured but the script is not ready yet. */
export function reachGoal(goal: YmGoal): boolean {
  const id = counterId();
  if (id === null) return true;
  if (typeof window.ym !== "function") return false;
  window.ym(id, "reachGoal", goal);
  return true;
}

export function trackResumeEntered(value: string) {
  if (pasteTracked || !value.trim()) return;
  try {
    if (sessionStorage.getItem(PASTE_FLAG) === "1") {
      pasteTracked = true;
      return;
    }
  } catch {
    // sessionStorage can throw in private mode; the memory flag still limits this page.
  }
  if (!reachGoal(YM_GOALS.pasteResume)) return;
  pasteTracked = true;
  try {
    sessionStorage.setItem(PASTE_FLAG, "1");
  } catch {
    // already recorded for this page load
  }
}
