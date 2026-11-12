import "./Pagination.css";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight } from "./icons";
import TooltipButton from "./TooltipButton";
import { Select } from "./Select";
import { paginationPages, paginationRange } from "../utils/pagination.ts";

type PaginationProps = {
  label: string;
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  pageSizes: readonly number[];
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
};

// A page bar: how many items a page shows, which ones this page holds, and
// the pages to go to, as in "Items per page 100 · 101–200 of 2,117 · ‹ Prev 1 2
// 3 … 22 Next ›".
export function Pagination({
  label,
  page,
  totalPages,
  total,
  pageSize,
  pageSizes,
  onPage,
  onPageSize,
}: PaginationProps) {
  const lastPage = Math.max(totalPages, 1);
  return (
    <nav className="pagination" aria-label={label}>
      <div className="pagination__size">
        <span aria-hidden="true">Items per page</span>
        <Select
          className=""
          value={pageSize}
          options={pageSizes.map((size) => ({ value: size, label: String(size) }))}
          onChange={onPageSize}
          aria-label="Items per page"
        />
      </div>
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

// A compact Previous / Page N / Next stepper for lists without a page-size picker.
export default function PageStepper({
  page,
  pageCount,
  hasMore = false,
  label,
  onChange,
}: {
  page: number;
  pageCount: number;
  hasMore?: boolean;
  label: string;
  onChange: (page: number) => void;
}) {
  if (pageCount <= 1 && !hasMore) return null;
  return (
    <nav className="native-library-pagination" aria-label={label}>
      <TooltipButton
        className="native-library-icon-button"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        label="Previous page"
        aria-label="Previous page"
      >
        <ArrowLeft aria-hidden="true" />
      </TooltipButton>
      <span>{hasMore ? `Page ${page}` : `Page ${page} of ${pageCount}`}</span>
      <TooltipButton
        className="native-library-icon-button"
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount && !hasMore}
        label="Next page"
        aria-label="Next page"
      >
        <ArrowRight aria-hidden="true" />
      </TooltipButton>
    </nav>
  );
}
