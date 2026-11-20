export class AnalyzeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AnalyzeError";
    this.status = status;
  }
}
