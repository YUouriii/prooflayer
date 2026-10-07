export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * Bound list pagination so no endpoint can accidentally dump an unbounded
 * organization dataset. Non-numeric or out-of-range input falls back to
 * safe defaults instead of reaching the database.
 */
export function clampPagination(page: unknown, limit: unknown): { page: number; limit: number } {
  const pageNumber = Number(page);
  const limitNumber = Number(limit);
  return {
    page: Number.isFinite(pageNumber) ? Math.max(1, Math.floor(pageNumber)) : DEFAULT_PAGE,
    limit: Number.isFinite(limitNumber)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitNumber)))
      : DEFAULT_LIMIT,
  };
}
