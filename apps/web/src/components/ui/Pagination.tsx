import { ArrowLeftIcon, ArrowRightIcon } from '@/components/icons';
import type { Dictionary } from '@/i18n/dictionary';
import { ButtonLink } from './Button';

/**
 * Range summary plus prev/next. The same 25 lines lived in the audit table and
 * the PR list, differing only in how they built the href.
 */
export function Pagination({
  dict,
  hrefFor,
  page,
  pageSize,
  total,
}: {
  dict?: Dictionary;
  /** Builds the link for a given 1-based page. */
  hrefFor: (page: number) => string;
  page: number;
  pageSize: number;
  total: number;
}) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) {
    return null;
  }
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const prev = dict?.common.prev ?? 'Previous';
  const next = dict?.common.next ?? 'Next';
  const of = dict?.common.of ?? 'of';

  return (
    <div className="flex flex-col items-center justify-between gap-3 sm:flex-row text-sm">
      <p className="text-text-3">
        {first}–{last} {of} {total}
      </p>
      <div className="flex gap-2">
        {page > 1 && (
          <ButtonLink href={hrefFor(page - 1)} variant="secondary" size="sm">
            <ArrowLeftIcon /> {prev}
          </ButtonLink>
        )}
        {page < totalPages && (
          <ButtonLink href={hrefFor(page + 1)} variant="secondary" size="sm">
            {next} <ArrowRightIcon />
          </ButtonLink>
        )}
      </div>
    </div>
  );
}
