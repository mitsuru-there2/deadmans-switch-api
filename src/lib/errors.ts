export class AppError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503,
    public code: string,
  ) {
    super(code);
  }
}
export function requireValue<T>(value: T | undefined | null, code = "NOT_FOUND"): T {
  if (value == null) throw new AppError(404, code);
  return value;
}
