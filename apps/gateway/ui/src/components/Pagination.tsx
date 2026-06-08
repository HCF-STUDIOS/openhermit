import { useEffect, useMemo, useState } from 'react';

/** Default rows per page across the admin list panels. */
export const DEFAULT_PAGE_SIZE = 20;

interface PaginationState<T> {
  /** 1-based current page. */
  page: number;
  setPage: (page: number) => void;
  /** Total number of pages (>= 1). */
  pageCount: number;
  /** The slice of `items` for the current page. */
  pageItems: T[];
  total: number;
  pageSize: number;
}

/**
 * Client-side pagination over an in-memory array. The page auto-clamps when
 * the list shrinks (e.g. after a delete or filter change) so we never strand
 * the user on an empty page.
 */
export function usePagination<T>(items: T[], pageSize: number = DEFAULT_PAGE_SIZE): PaginationState<T> {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const safePage = Math.min(page, pageCount);
  const pageItems = useMemo(
    () => items.slice((safePage - 1) * pageSize, safePage * pageSize),
    [items, safePage, pageSize],
  );

  return { page: safePage, setPage, pageCount, pageItems, total: items.length, pageSize };
}

/**
 * Compact pager: "X–Y of N" plus Prev/Next. Renders nothing when everything
 * fits on a single page.
 */
export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="pagination__info">
        {from}–{to} of {total}
      </span>
      <div className="pagination__controls">
        <button
          className="btn btn--ghost btn--sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Prev
        </button>
        <span className="pagination__page">
          {page} / {pageCount}
        </span>
        <button
          className="btn btn--ghost btn--sm"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
