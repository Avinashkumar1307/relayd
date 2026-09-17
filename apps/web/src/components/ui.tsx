import type { ReactNode } from 'react';
import { ApiError } from '../api/client.js';

/**
 * Shared page furniture.
 *
 * Every list page in the audience section has the same skeleton — a heading,
 * an action, a table, an empty state and a failure state — and the value of
 * putting it here is that the failure and empty states get written once and
 * are therefore written properly. A page that quietly renders an empty table
 * when a request failed is the most common way a dashboard lies.
 */

export function Page({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description !== undefined && <p className="text-sm text-slate-600">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" className="py-10 text-sm text-slate-500">
      {label}
    </p>
  );
}

/**
 * A failure the user can act on.
 *
 * Shows the server's message when there is one. "Something went wrong" tells
 * a user nothing and tells support less; the request id is what turns a
 * complaint into a log search.
 */
export function LoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const apiError = error instanceof ApiError ? error : null;

  return (
    <div role="alert" className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-medium text-red-800">
        {apiError?.message ?? 'That did not load.'}
      </p>
      {apiError?.requestId !== undefined && (
        <p className="text-xs text-red-700">Reference: {apiError.requestId}</p>
      )}
      {onRetry !== undefined && (
        <button type="button" onClick={onRetry} className="text-sm text-red-800 underline">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {children !== undefined && <div className="mt-2 text-sm text-slate-600">{children}</div>}
    </div>
  );
}

export function Button({
  children,
  variant = 'primary',
  ...props
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    primary: 'bg-slate-900 text-white hover:bg-slate-800',
    secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
    danger: 'border border-red-300 bg-white text-red-700 hover:bg-red-50',
  } as const;

  return (
    <button
      type="button"
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

export function Table({
  columns,
  children,
  caption,
}: {
  columns: readonly string[];
  children: ReactNode;
  caption?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        {caption !== undefined && <caption className="sr-only">{caption}</caption>}
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className="px-4 py-2 font-medium text-slate-600">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <td className={`px-4 py-2 ${muted === true ? 'text-slate-500' : 'text-slate-900'}`}>{children}</td>;
}

/**
 * A coloured status word.
 *
 * Colour is never the only signal — the word is always present — because a
 * red dot means nothing to anyone who cannot distinguish it from the green one.
 */
export function Badge({ tone, children }: { tone: 'neutral' | 'good' | 'warn' | 'bad'; children: ReactNode }) {
  const styles = {
    neutral: 'bg-slate-100 text-slate-700',
    good: 'bg-emerald-100 text-emerald-800',
    warn: 'bg-amber-100 text-amber-800',
    bad: 'bg-red-100 text-red-800',
  } as const;

  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles[tone]}`}>
      {children}
    </span>
  );
}

export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}
