import type { ReactNode } from 'react';
import { BrandMark, Icon } from '@relayd/ui';

/**
 * The section B page frame (design/B Auth & onboarding.dc.html, B1–B6).
 *
 * `AuthLayout` in `@relayd/ui` draws this shape for the one case it was
 * written against — B1 — and section B has eleven other frames it cannot
 * express. The frames differ from it in six measured ways:
 *
 *   top padding      96 (B1, B3, B4, B5a) · 80 (B6a) · 64 (B5b) · 56 (B2)
 *   card gap         20 everywhere except B3a–c, which are 16
 *   card alignment   B3a–c and B4a-sent are `align-items:flex-start`
 *   a leading icon   the 44px status tile above the heading on B3 and B4a-sent
 *   a custom heading B5's monogram + 20px title row, not the 24px title block
 *   an eyebrow       B6a's "Step 1 of 2" above the title
 *
 * So the chrome is rebuilt here, in the section that needs it, and reported
 * as a gap: the right end state is these six props on `AuthLayout` and this
 * file deleted. Everything below is measured from the frames, and the brand
 * mark is still the shared `BrandMark` so the logo cannot drift.
 *
 * Mobile (B1m, B2m) is the same column with the card's chrome removed: no
 * border, no surface fill, 20px side padding, and the footer centred with
 * "Status" dropped. `sm:` is the switch, so 390px gets the mobile frame and
 * anything wider gets the 440px card.
 */

export type AuthFrameTop = 56 | 64 | 80 | 96;

const TOP: Record<AuthFrameTop, string> = {
  // The mobile frames vary too: B2m, the tallest form, opens at 40 and every
  // other one at 56.
  56: 'pt-10 sm:pt-14',
  64: 'pt-14 sm:pt-16',
  80: 'pt-14 sm:pt-20',
  96: 'pt-14 sm:pt-24',
};

export interface AuthFrameProps {
  children: ReactNode;
  /** The frame's desktop top padding. Mobile is always 56. */
  top?: AuthFrameTop;
  /** 20px on every frame but B3a–c, which are 16. */
  gap?: 16 | 20;
  /** B3a–c and B4a-sent pack their contents to the left edge. */
  alignStart?: boolean;
  /** The line under the card, e.g. "New to Relayd? Create an account". */
  after?: ReactNode;
}

export function AuthFrame({ children, top = 96, gap = 20, alignStart = false, after }: AuthFrameProps) {
  return (
    <div className={`flex min-h-screen flex-col items-center bg-bg px-5 pb-6 text-body text-text sm:px-4 sm:pb-8 ${TOP[top]}`}>
      <div className="mb-7 flex items-center gap-2.5 self-start sm:self-auto">
        <BrandMark size={36} />
        <span className="text-section font-semibold tracking-heading">Relayd</span>
      </div>

      <div
        className={[
          'flex w-full max-w-[440px] flex-col rounded-card border border-transparent bg-bg p-0',
          'sm:border-border sm:bg-surface sm:p-8',
          // B1m and B2m size the form up on a phone: 44px boxes at 16px —
          // which is also the size below which iOS zooms the page on focus —
          // and a 48px submit. Back to the desktop 40/14 at `sm:`. Checkboxes
          // are excluded: B2m's consent tick is the same 18px box at both
          // widths.
          '[&_input:not([type=checkbox])]:h-11 [&_input:not([type=checkbox])]:text-card',
          '[&_select]:h-11 [&_select]:text-card',
          '[&_form>button]:h-12 [&_form>button]:text-card',
          'sm:[&_input:not([type=checkbox])]:h-10 sm:[&_input:not([type=checkbox])]:text-body',
          'sm:[&_select]:h-10 sm:[&_select]:text-body',
          'sm:[&_form>button]:h-10 sm:[&_form>button]:text-body',
          gap === 16 ? 'gap-4' : 'gap-5',
          alignStart ? 'items-start' : '',
        ].join(' ')}
      >
        {children}
      </div>

      {after === undefined ? null : (
        <p className="mb-0 mt-5 text-center text-body text-text-2 sm:text-ui">{after}</p>
      )}

      {/* margin-top:auto in every frame; the column's own bottom padding is
          the only space beneath it. */}
      <footer className="mt-auto flex justify-center gap-4 pt-10 text-caption text-text-3">
        <span>© 2026 Relayd</span>
        <a href="/privacy" className="text-inherit no-underline hover:text-text-2">
          Privacy
        </a>
        <a href="/terms" className="text-inherit no-underline hover:text-text-2">
          Terms
        </a>
        {/* B1m drops Status; the desktop frames keep it. */}
        <a href="https://status.relayd.io" className="hidden text-inherit no-underline hover:text-text-2 sm:inline">
          Status
        </a>
      </footer>
    </div>
  );
}

/**
 * The card's heading block: an optional eyebrow, a 24px title and a
 * secondary line. `spaced` is the 8px gap B3 and B4a-sent put under the
 * title; every form frame uses 6px.
 */
export function AuthHeading({
  eyebrow,
  title,
  children,
  spaced = false,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  spaced?: boolean;
}) {
  return (
    <div>
      {eyebrow === undefined ? null : (
        <div className="mb-2 text-caption font-medium text-text-2">{eyebrow}</div>
      )}
      <h1 className="m-0 text-title font-semibold leading-heading tracking-heading">{title}</h1>
      {children === undefined ? null : (
        <p className={`mb-0 text-text-2 text-pretty ${spaced ? 'mt-2' : 'mt-1.5'}`}>{children}</p>
      )}
    </div>
  );
}

/** An address or other value called out inside a sentence of secondary text. */
export function Strong({ children }: { children: ReactNode }) {
  return <span className="font-medium text-text">{children}</span>;
}

export type NoticeTone = 'info' | 'success' | 'warning';

const NOTICE_TONE: Record<NoticeTone, string> = {
  info: 'bg-info-soft text-info-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
};

/** The 44px status tile above the heading on B3a, B3b, B3c and B4a-sent. */
export function NoticeIcon({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  return (
    <span className={`grid h-11 w-11 flex-none place-items-center rounded-card ${NOTICE_TONE[tone]}`}>
      {children}
    </span>
  );
}

/**
 * The clock face on B3c.
 *
 * `ICON_PATHS` has no `clock`, and the shared `Icon` only draws names from
 * that map, so this one path is local until the set gains it.
 */
export function ClockIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

/** The mail envelope on B3a and B4a-sent. */
export function MailIcon({ size = 20 }: { size?: number }) {
  return <Icon name="mail" size={size} strokeWidth={1.75} />;
}
