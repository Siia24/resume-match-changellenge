export class AnalyzeError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly body: string;

  constructor(status: number, message: string, retryable = false, httpStatus = 0, body = "") {
    super(message);
    this.name = "AnalyzeError";
    this.status = status;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    this.body = body;
  }
}
