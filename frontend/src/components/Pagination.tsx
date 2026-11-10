import "./Pagination.css";
import { ChevronLeft, ChevronRight } from "./icons";
import { paginationPages, paginationRange } from "../utils/pagination.ts";

type PaginationProps = {
  label: string;
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
};

// Numbered page navigation and the visible item range.
export function Pagination({ label, page, totalPages, total, pageSize, onPage }: PaginationProps) {
  const lastPage = Math.max(totalPages, 1);
  return (
    <nav className="pagination" aria-label={label}>
      <span className="pagination__range">{paginationRange(page, pageSize, total)}</span>
      <div className="pagination__pages">
        <button
          type="button"
          className="pagination__step"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft aria-hidden="true" />
          <span>Prev</span>
        </button>
        {paginationPages(page, lastPage).map((entry, index) =>
          entry === "gap" ? (
            <span key={`gap-${index}`} className="pagination__gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              className="pagination__page"
              onClick={() => onPage(entry)}
              aria-current={entry === page ? "page" : undefined}
              aria-label={`Page ${entry}`}
            >
              {entry}
            </button>
          ),
        )}
        <button
          type="button"
          className="pagination__step"
          onClick={() => onPage(page + 1)}
          disabled={page >= lastPage}
          aria-label="Next page"
        >
          <span>Next</span>
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
