/** A request the store refuses, with the HTTP status the server answers it with. */
export class SubmitError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
