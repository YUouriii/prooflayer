import { describe, it, expect } from 'vitest';
import { DEFAULT_LIMIT, DEFAULT_PAGE, MAX_LIMIT, clampPagination } from '../utils/pagination.js';

describe('clampPagination', () => {
  it('defaults missing input', () => {
    expect(clampPagination(undefined, undefined)).toEqual({ page: DEFAULT_PAGE, limit: DEFAULT_LIMIT });
  });

  it('accepts sane values including numeric strings', () => {
    expect(clampPagination('2', '50')).toEqual({ page: 2, limit: 50 });
  });

  it('caps runaway limits at MAX_LIMIT', () => {
    expect(clampPagination(1, 1000000).limit).toBe(MAX_LIMIT);
  });

  it('floors page and limit at 1 and rejects garbage', () => {
    expect(clampPagination(0, 0)).toEqual({ page: 1, limit: 1 });
    expect(clampPagination(-3, -3)).toEqual({ page: 1, limit: 1 });
    expect(clampPagination('abc', 'xyz')).toEqual({ page: DEFAULT_PAGE, limit: DEFAULT_LIMIT });
    expect(clampPagination(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ page: DEFAULT_PAGE, limit: DEFAULT_LIMIT });
  });
});
