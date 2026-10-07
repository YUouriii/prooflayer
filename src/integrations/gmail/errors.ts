/**
 * Gmail error taxonomy.
 *
 * Critical semantic: infrastructure failures (auth revoked, rate limits,
 * API outages) must surface as UNKNOWN evidence — never as proof that an
 * email was not sent. These classes let the provider tell the difference.
 */

export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailAuthError';
  }
}

export class GmailRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailRateLimitError';
  }
}

export class GmailApiError extends Error {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'GmailApiError';
    this.statusCode = statusCode;
  }
}

function errorReason(error: unknown): { code?: number; reason?: string; message: string } {
  if (typeof error !== 'object' || error === null) {
    return { message: String(error) };
  }
  const record = error as Record<string, unknown>;
  // googleapis GaxiosError shape: { code, response: { data: { error: { errors: [{ reason }] } } } }
  const response = record.response as Record<string, unknown> | undefined;
  const data = response?.data as Record<string, unknown> | undefined;
  const payload = data?.error as Record<string, unknown> | undefined;
  const errors = payload?.errors as Array<Record<string, unknown>> | undefined;
  const reason = typeof errors?.[0]?.reason === 'string' ? (errors[0].reason as string) : undefined;
  const code = typeof record.code === 'number' ? record.code : undefined;
  const message =
    typeof payload?.message === 'string'
      ? payload.message
      : typeof record.message === 'string'
        ? record.message
        : 'Gmail API request failed';
  return { code, reason, message };
}

/** Map a raw googleapis error onto the taxonomy above. */
export function classifyGmailError(error: unknown): GmailAuthError | GmailRateLimitError | GmailApiError {
  const { code, reason, message } = errorReason(error);
  if (code === 401 || code === 403 || reason === 'authError' || /invalid_grant|invalid credentials|revoked/i.test(message)) {
    return new GmailAuthError(message);
  }
  if (code === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return new GmailRateLimitError(message);
  }
  return new GmailApiError(message, code);
}
