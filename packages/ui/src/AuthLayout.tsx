import type { ReactNode } from 'react';
import { BrandMark } from './Shell.js';

/**
 * The unauthenticated page frame (design/B Auth & onboarding.dc.html, B1–B6).
 *
 * Every auth frame is the same shape: the canvas colour, a centred column
 * with 96px above, a 36px brand mark and 20/600 wordmark, a 440px card on the
 * surface colour with a 12px radius and 32px padding, and a footer pinned to
 * the bottom in 12px tertiary text. The card's contents are the only thing
 * that changes between B1 and B6, so the frame is one component and the
 * pages supply the card.
 *
 * `width` exists for B6, whose create-workspace card is wider than a sign-in
 * form; nothing else should pass it.
 */
export interface AuthLayoutProps {
  title: string;
  /** The line under the title, in secondary text. */
  subtitle?: ReactNode | undefined;
  children: ReactNode;
  /** Below the card, e.g. "New to Relayd? Create an account". */
  after?: ReactNode | undefined;
  width?: number | undefined;
  /** Replaces the brand mark row — B5 shows the inviting workspace's monogram. */
  mark?: ReactNode | undefined;
}

export function AuthLayout({ title, subtitle, children, after, width = 440, mark }: AuthLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col items-center bg-bg px-4 pb-8 pt-24 text-body text-text">
      {mark ?? (
        <div className="mb-7 flex items-center gap-2.5">
          <BrandMark size={36} />
          <span className="text-section font-semibold tracking-heading">Relayd</span>
        </div>
      )}

      <div
        className="flex w-full flex-col gap-5 rounded-card border border-border bg-surface p-8"
        style={{ maxWidth: width }}
      >
        <div>
          <h1 className="m-0 text-title font-semibold leading-heading tracking-heading">{title}</h1>
          {subtitle !== undefined ? <p className="mb-0 mt-1.5 text-text-2">{subtitle}</p> : null}
        </div>
        {children}
      </div>

      {after !== undefined ? <p className="mb-0 mt-5 text-ui text-text-2">{after}</p> : null}

      {/* margin-top:auto in the frame; the page's own 32px bottom padding is
          the only space beneath it. */}
      <footer className="mt-auto flex gap-4 text-caption text-text-3">
        <span>© 2026 Relayd</span>
        <a href="/privacy" className="text-inherit no-underline hover:text-text-2">
          Privacy
        </a>
        <a href="/terms" className="text-inherit no-underline hover:text-text-2">
          Terms
        </a>
        <a href="https://status.relayd.io" className="text-inherit no-underline hover:text-text-2">
          Status
        </a>
      </footer>
    </div>
  );
}
