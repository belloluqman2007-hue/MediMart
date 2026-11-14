import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  if (error instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of error.issues)
      (fields[issue.path.join('.') || 'request'] ??= []).push(issue.message);
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Please check the information provided.',
        fields,
        requestId: req.requestId,
      },
    });
    return;
  }
  if (error instanceof ApiError) {
    res
      .status(error.status)
      .json({ error: { code: error.code, message: error.message, requestId: req.requestId } });
    return;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    ['entity.parse.failed', 'entity.too.large'].includes(String(error.type))
  ) {
    const status = error.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({
      error: {
        code: 'INVALID_BODY',
        message: 'The request body is invalid or too large.',
        requestId: req.requestId,
      },
    });
    return;
  }
  /**
   * Log only classification and correlation, never submitted bodies, secrets, SQL, or hashes.
   *
   * A SQLite message tells an operator which rule refused a write without printing the statement
   * or any row value; without it, `INTERNAL_ERROR` is untraceable in a shop with no log viewer.
   */
  /**
   * The SQLite error message is included when it is a constraint/vocabulary failure, because those
   * messages name a rule ("CHECK constraint failed: ..."), never a row value or a statement. Without
   * it an operator sees only `INTERNAL_ERROR` and cannot tell a validation gap from a real fault.
   * Everything else stays classified only.
   */
  const detail =
    error instanceof Error && error.name === 'SqliteError' && error.message.length <= 200
      ? error.message
      : undefined;
  console.error(
    JSON.stringify({
      level: 'error',
      requestId: req.requestId,
      kind: error instanceof Error ? error.name : 'UnknownError',
      ...(detail ? { detail } : {}),
    }),
  );
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed. Please try again.',
      requestId: req.requestId,
    },
  });
};
