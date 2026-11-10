// The page numbers a pagination bar shows, with "gap" where pages are skipped:
// always the first and last page and the pages beside the current one, as in
// 1 2 3 … 30. A gap never stands in for a single page, which is shown instead.
export function paginationPages(current: number, total: number): (number | "gap")[] {
  const last = Math.max(1, Math.floor(total));
  const page = Math.min(Math.max(1, Math.floor(current)), last);
  const shown = new Set([1, last, page - 1, page, page + 1]);
  // Near either end, show three pages there so the bar keeps its width.
  if (page <= 2) shown.add(3);
  if (page >= last - 1) shown.add(last - 2);
  const pages = [...shown].filter((number) => number >= 1 && number <= last).sort((a, b) => a - b);
  return pages.flatMap((number, index) => {
    const previous = pages[index - 1];
    if (previous === undefined || number - previous === 1) return [number];
    return number - previous === 2 ? [number - 1, number] : (["gap", number] as const);
  });
}

// "101–200 of 2,117" for the items a page shows.
export function paginationRange(page: number, pageSize: number, total: number) {
  if (total <= 0) return "0 of 0";
  const first = Math.min((page - 1) * pageSize + 1, total);
  const last = Math.min(page * pageSize, total);
  const format = (value: number) => value.toLocaleString();
  return `${format(first)}–${format(last)} of ${format(total)}`;
}
