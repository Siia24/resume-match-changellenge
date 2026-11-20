export class AnalyzeError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, message: string, retryable = false) {
    super(message);
    this.name = "AnalyzeError";
    this.status = status;
    this.retryable = retryable;
  }
}
