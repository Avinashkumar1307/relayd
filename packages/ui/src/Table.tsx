import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The data table (design/00 Design System.dc.html, "Data table";
 * design/D Audience.dc.html D1 and design/G Campaigns.dc.html G1).
 *
 * The sheet's rule, verbatim: "Saved views as tabs, column filters as chips,
 * server-side pagination in the footer. Selecting rows swaps the toolbar for
 * a bulk-action bar. Sticky header; density toggle." And under it: "Row
 * states shown: selected (brand soft), default, hover (tint), suppressed
 * (muted text). Contacts rows never hide suppression; the status badge says
 * why."
 *
 * ## Why a `<table>` when the frames draw a CSS grid
 *
 * The export lays the rows out with `display: grid` and fixed column
 * templates. That is a rendering technique, not a semantic decision: the
 * thing on screen is a table with a header row, and a screen reader that is
 * handed a pile of divs cannot say "row 4 of 8, column Status". So the
 * markup here is a real `<table>` with `<colgroup>` carrying the widths the
 * frames put in `grid-template-columns`, which produces the same layout with
 * `table-fixed` and keeps the semantics. Every measured value is the frame's:
 *
 *   header  `background: var(--tint)`, 12/500 on `--text-2`, cells
 *           `padding: 8px 12px` with 16px at the outer edges
 *   row     `border-bottom: 1px solid var(--border)`, 13px, cells
 *           `padding: 12px`, `min-height: 56px` on G1
 *   states  selected `--brand-soft`, hover `--tint`, muted `--text-2`
 *   toolbar `padding: 12px 16px; gap: 8px; flex-wrap: wrap; font-size: 12px`
 *   bulk    `padding: 10px 16px; background: var(--brand-soft)`, 30px buttons
 *   footer  `padding: 10px 16px`, 12px on `--text-2`
 *
 * ## Selection
 *
 * The header box is tri-state: unchecked, a dash when some rows are picked
 * (the frames draw `M5 12h14` there), a tick when all are. It is a real
 * `<input type="checkbox">` behind the drawn box so the keyboard, the
 * accessibility tree and form semantics all work; `indeterminate` is a DOM
 * property, not an attribute, so it is set through a ref.
 */

export type ColumnAlign = 'left' | 'right';

export interface Column<Row> {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  align?: ColumnAlign | undefined;
  /**
   * A CSS width for this column's `<col>`: `'130px'`, or `'22%'` for one of
   * the frames' proportional tracks. Leave it off to take what is left.
   * `minmax(0,1.4fr)` is a grid value and `<col>` does not accept it, so a
   * `1.4fr` track becomes its share as a percentage.
   */
  width?: string | undefined;
  /** Ids, message ids, request ids: JetBrains Mono, as everywhere else. */
  mono?: boolean | undefined;
  sortable?: boolean | undefined;
}

export type SortDirection = 'asc' | 'desc';

export interface DataTableProps<Row> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Names the table for a screen reader: "Contacts". */
  label: string;

  /** Selection is on when `onSelectionChange` is given. */
  selectedKeys?: readonly string[] | undefined;
  onSelectionChange?: ((keys: string[]) => void) | undefined;
  /** The per-row checkbox label: "Select amira.khalil@example.ae". */
  selectionLabel?: ((row: Row) => string) | undefined;

  sort?: { key: string; direction: SortDirection } | undefined;
  onSortChange?: ((key: string, direction: SortDirection) => void) | undefined;

  onRowClick?: ((row: Row) => void) | undefined;
  /** Suppressed rows: the sheet's "muted text" state. */
  rowMuted?: ((row: Row) => boolean) | undefined;

  /** Sticks the header while the body scrolls; pair with `maxHeight`. */
  stickyHeader?: boolean | undefined;
  maxHeight?: number | undefined;

  /** Filters and search, above the header. Hidden while rows are selected. */
  toolbar?: ReactNode | undefined;
  /** The selected-rows strip — a `BulkBar`. Replaces the toolbar. */
  bulkBar?: ReactNode | undefined;
  /** Pagination: "1–25 of 1,240" and the prev/next pair. */
  footer?: ReactNode | undefined;

  /** Shown in place of the body when there are no rows. */
  empty?: ReactNode | undefined;
  /** Shown in place of the body while loading; wins over `empty`. */
  loading?: ReactNode | undefined;

  className?: string | undefined;
}

const ARIA_SORT: Record<SortDirection, 'ascending' | 'descending'> = {
  asc: 'ascending',
  desc: 'descending',
};

function SelectBox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (input.current !== null) input.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const on = checked || indeterminate;

  return (
    <label className="relative inline-flex h-4 w-4 align-middle">
      <input
        ref={input}
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
        onClick={(event) => event.stopPropagation()}
        className="peer absolute inset-0 z-1 m-0 h-full w-full cursor-pointer opacity-0"
      />
      <span
        aria-hidden="true"
        className={[
          'grid h-4 w-4 place-items-center rounded-4 border box-border text-white',
          'peer-focus-visible:ring-[3px] peer-focus-visible:ring-brand-soft',
          on ? 'bg-brand border-brand' : 'bg-surface border-border',
        ].join(' ')}
      >
        {on ? (
          <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <path d={indeterminate ? 'M5 12h14' : 'M20 6L9 17l-5-5'} />
          </svg>
        ) : null}
      </span>
    </label>
  );
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  label,
  selectedKeys,
  onSelectionChange,
  selectionLabel,
  sort,
  onSortChange,
  onRowClick,
  rowMuted,
  stickyHeader = false,
  maxHeight,
  toolbar,
  bulkBar,
  footer,
  empty,
  loading,
  className = '',
}: DataTableProps<Row>) {
  const selectable = onSelectionChange !== undefined;
  const selected = new Set(selectedKeys ?? []);
  const allKeys = rows.map(rowKey);
  const pickedOnPage = allKeys.filter((key) => selected.has(key)).length;
  const span = columns.length + (selectable ? 1 : 0);

  // Select-all is select-all-on-this-page: a selection made on page 2 must
  // survive page 3, and "select every row that matches the filter" is a
  // server-side idea the caller owns, not something a header box can mean.
  const toggleAll = (next: boolean) => {
    if (onSelectionChange === undefined) return;
    onSelectionChange(
      next
        ? Array.from(new Set([...selected, ...allKeys]))
        : Array.from(selected).filter((key) => !allKeys.includes(key)),
    );
  };

  const toggleRow = (key: string, next: boolean) => {
    if (onSelectionChange === undefined) return;
    const copy = new Set(selected);
    if (next) copy.add(key);
    else copy.delete(key);
    onSelectionChange(Array.from(copy));
  };

  const headCell = (column: Column<Row>) => {
    const active = sort !== undefined && sort.key === column.key ? sort.direction : undefined;
    const align = column.align === 'right' ? 'text-right' : 'text-left';

    return (
      <th
        key={column.key}
        scope="col"
        aria-sort={column.sortable === true ? (active === undefined ? 'none' : ARIA_SORT[active]) : undefined}
        className={`px-3 py-2 font-medium first:pl-4 last:pr-4 ${align}`}
      >
        {column.sortable === true && onSortChange !== undefined ? (
          <button
            type="button"
            // The frames label the sorted column "Created ↓": the first click
            // on a new column sorts descending, and clicking it again flips.
            onClick={() => onSortChange(column.key, active === 'desc' ? 'asc' : 'desc')}
            className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-medium text-text-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft"
          >
            {column.header}
            {active === undefined ? null : <span aria-hidden="true">{active === 'asc' ? '↑' : '↓'}</span>}
          </button>
        ) : (
          column.header
        )}
      </th>
    );
  };

  const body = () => {
    if (loading !== undefined) {
      return (
        <tr>
          <td colSpan={span} className="p-0">
            {loading}
          </td>
        </tr>
      );
    }
    if (rows.length === 0) {
      return (
        <tr>
          <td colSpan={span} className="p-0">
            {empty}
          </td>
        </tr>
      );
    }

    return rows.map((row) => {
      const key = rowKey(row);
      const on = selected.has(key);
      const muted = rowMuted?.(row) === true;

      return (
        <tr
          key={key}
          // Not `aria-selected`: that belongs to a grid, and this is a table.
          // The row's checkbox is what states the selection.
          data-selected={on ? '' : undefined}
          onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
          className={[
            'border-b border-border',
            on ? 'bg-brand-soft text-text' : muted ? 'text-text-2 hover:bg-tint' : 'text-text hover:bg-tint',
            onRowClick === undefined ? '' : 'cursor-pointer',
          ].join(' ')}
        >
          {selectable ? (
            <td className="h-14 pl-4 align-middle">
              <SelectBox
                checked={on}
                onChange={(next) => toggleRow(key, next)}
                label={selectionLabel?.(row) ?? `Select row ${key}`}
              />
            </td>
          ) : null}
          {columns.map((column) => (
            <td
              key={column.key}
              className={[
                'h-14 px-3 py-3 align-middle first:pl-4 last:pr-4',
                column.align === 'right' ? 'text-right tabular-nums' : 'text-left',
                column.mono === true ? 'font-mono' : '',
              ].join(' ')}
            >
              {column.cell(row)}
            </td>
          ))}
        </tr>
      );
    });
  };

  return (
    <div className={`overflow-hidden rounded-card border border-border bg-surface ${className}`}>
      {/* "Selecting rows swaps the toolbar for a bulk-action bar." */}
      {bulkBar !== undefined ? (
        bulkBar
      ) : toolbar === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-caption">{toolbar}</div>
      )}

      <div
        className={maxHeight === undefined ? 'overflow-x-auto' : 'overflow-auto'}
        style={maxHeight === undefined ? undefined : { maxHeight }}
      >
        <table className="w-full table-fixed border-collapse text-ui" aria-label={label}>
          <colgroup>
            {selectable ? <col style={{ width: 44 }} /> : null}
            {columns.map((column) => (
              <col key={column.key} style={column.width === undefined ? undefined : { width: column.width }} />
            ))}
          </colgroup>

          <thead
            className={[
              'bg-tint text-caption text-text-2',
              stickyHeader ? 'sticky top-0 z-1' : '',
            ].join(' ')}
          >
            <tr className="border-b border-border">
              {selectable ? (
                <th scope="col" className="py-2 pl-4 text-left">
                  <SelectBox
                    checked={rows.length > 0 && pickedOnPage === rows.length}
                    indeterminate={pickedOnPage > 0 && pickedOnPage < rows.length}
                    onChange={toggleAll}
                    label="Select all rows"
                  />
                </th>
              ) : null}
              {columns.map(headCell)}
            </tr>
          </thead>

          <tbody>{body()}</tbody>
        </table>
      </div>

      {footer === undefined ? null : (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-caption text-text-2">{footer}</div>
      )}
    </div>
  );
}

/**
 * The selected-rows strip (D1 and the sheet): "2 selected", a divider, the
 * bulk actions as 30px secondary buttons, and Clear pushed to the right.
 *
 * It takes the actions as data rather than as children because the button
 * geometry — `height: 30; padding: 0 10px; font-size: 12` — is part of the
 * design, not of the caller, and a destructive one is `--danger-text` on the
 * ordinary surface, never a filled danger button. A filled red button inside
 * a selection bar reads as the primary thing to do with a selection.
 */
export interface BulkAction {
  key: string;
  label: ReactNode;
  onClick: () => void;
  /** "Suppress", "Delete": the label turns `--danger-text`. */
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  title?: string | undefined;
}

export interface BulkBarProps {
  count: number;
  actions: readonly BulkAction[];
  onClear: () => void;
  clearLabel?: string | undefined;
  /** Anything the action list cannot express — a menu, a chip. */
  children?: ReactNode | undefined;
}

export function BulkBar({ count, actions, onClear, clearLabel = 'Clear', children }: BulkBarProps) {
  return (
    <div role="toolbar" aria-label={`${count} selected`} className="flex flex-wrap items-center gap-2 bg-brand-soft px-4 py-2.5 text-ui">
      <span className="font-medium text-brand">{count} selected</span>
      <span aria-hidden="true" className="mx-1 h-4.5 w-px bg-border" />

      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          onClick={action.onClick}
          disabled={action.disabled === true}
          title={action.title}
          className={[
            'inline-flex h-7.5 items-center rounded-control border border-border bg-surface px-2.5 text-caption font-medium',
            'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft',
            action.disabled === true ? 'cursor-not-allowed text-text-3' : 'cursor-pointer',
            action.danger === true ? 'text-danger-text' : 'text-text',
          ].join(' ')}
        >
          {action.label}
        </button>
      ))}

      {children}

      <span className="flex-1" />

      <button
        type="button"
        onClick={onClear}
        className="inline-flex h-7.5 cursor-pointer items-center rounded-control border-0 bg-transparent px-2.5 text-caption font-medium text-text-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft"
      >
        {clearLabel}
      </button>
    </div>
  );
}
