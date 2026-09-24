/** Fout met een HTTP-status; `handler` in api.ts geeft die status terug in plaats van 500. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
