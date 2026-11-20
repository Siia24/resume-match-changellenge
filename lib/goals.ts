export const YM_GOALS = {
  pasteResume: "paste_resume",
  getAnalysis: "get_analysis",
  copyFix: "copy_fix",
} as const;

export type YmGoal = (typeof YM_GOALS)[keyof typeof YM_GOALS];
