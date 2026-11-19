export const ERROR_CODES = {
  invalidArgument: "invalid_argument",
  notFound: "not_found",
  alreadyExists: "already_exists",
  preconditionFailed: "precondition_failed",
  methodNotAllowed: "method_not_allowed",
  internal: "internal",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_argument: 400,
  not_found: 404,
  already_exists: 409,
  precondition_failed: 412,
  method_not_allowed: 405,
  internal: 500,
};

export interface LamedErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Readonly<Record<string, unknown>>;
  };
}

export class LamedError extends Error {
  readonly code: ErrorCode;

  readonly status: number;

  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "LamedError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toJSON(): LamedErrorBody {
    const error: LamedErrorBody["error"] = {
      code: this.code,
      message: this.message,
    };

    if (this.details) {
      error.details = this.details;
    }

    return { error };
  }
}

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, value);
}
