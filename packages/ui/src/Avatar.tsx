/**
 * Initials: the round person avatar and the square entity monogram
 * (design/J Settings & API.dc.html `avatar`; design/Shell.dc.html and
 * design/01 Shell + Dashboard options.dc.html for the monograms).
 *
 * Both are the same idea — two letters on a tint — but the frames keep them
 * apart and so does this file: a *person* is round, an *entity* (workspace,
 * provider connection) is a rounded square, and a provider's kind code is
 * set in JetBrains Mono because it is an identifier, not a name.
 *
 * Every size below was measured, with its radius and type size, and nothing
 * between them is offered:
 *
 *   Avatar   24 / 10px   28 / 11px   30 / 11px   32 / 12px    all `rounded-full`
 *   Monogram 22 / r5 10px · 28 / r6 11px · 36 / r8 11px mono ·
 *            40 / r10 12px mono · 44 / r10 12px mono · 48 / r12 15px
 *
 * Tones are the two the frames use: `brand` (brand-soft on brand, everywhere
 * in the app) and `sidebar` (the white chip on the navy, which stays navy in
 * both themes). `system` is the audit log's "Relayd" actor — the navy fill
 * with white letters that marks an action nobody took by hand.
 */

export type AvatarTone = 'brand' | 'sidebar' | 'system';

const TONE: Record<AvatarTone, string> = {
  brand: 'bg-brand-soft text-brand',
  sidebar: 'bg-sidebar-chip text-white',
  system: 'bg-sidebar text-white',
};

export type AvatarSize = 24 | 28 | 30 | 32;

const AVATAR: Record<AvatarSize, string> = {
  24: 'h-6 w-6 text-pill',
  28: 'h-7 w-7 text-label',
  30: 'h-[30px] w-[30px] text-label',
  32: 'h-8 w-8 text-caption',
};

export interface AvatarProps {
  /** One or two letters. Callers derive them; this never guesses. */
  initials: string;
  /** The whole name, for the tooltip and the accessible label. */
  name?: string | undefined;
  size?: AvatarSize | undefined;
  tone?: AvatarTone | undefined;
  className?: string | undefined;
}

export function Avatar({ initials, name, size = 30, tone = 'brand', className = '' }: AvatarProps) {
  return (
    <span
      title={name}
      aria-hidden={name === undefined ? true : undefined}
      aria-label={name}
      role={name === undefined ? undefined : 'img'}
      className={[
        'grid flex-none place-items-center rounded-full font-semibold',
        AVATAR[size],
        TONE[tone],
        className,
      ].join(' ')}
    >
      {initials}
    </span>
  );
}

export type MonogramSize = 22 | 28 | 36 | 40 | 44 | 48;

interface MonogramStyle {
  box: string;
  /** The 40 and 44 provider chips are set in mono at 500, not 600. */
  mono: boolean;
  weight: string;
}

const MONOGRAM: Record<MonogramSize, MonogramStyle> = {
  22: { box: 'h-[22px] w-[22px] rounded-5 text-pill', mono: false, weight: 'font-semibold' },
  28: { box: 'h-7 w-7 rounded-badge text-label tracking-monogram', mono: false, weight: 'font-semibold' },
  36: { box: 'h-9 w-9 rounded-control text-label', mono: true, weight: 'font-semibold' },
  40: { box: 'h-10 w-10 rounded-10 text-caption', mono: true, weight: 'font-medium' },
  44: { box: 'h-11 w-11 rounded-10 text-caption', mono: true, weight: 'font-medium' },
  // 15px is the one type size the frames use that the sheet's scale does not
  // name (B5's invite header); it is measured, so it is written as measured.
  48: { box: 'h-12 w-12 rounded-card text-[15px]', mono: false, weight: 'font-semibold' },
};

export interface MonogramProps {
  /** "NV" for a workspace, "SES" for a provider kind. */
  children: string;
  /** The full name, for the tooltip and the accessible label. */
  name?: string | undefined;
  size?: MonogramSize | undefined;
  tone?: AvatarTone | undefined;
  /** Overrides the size's default face — an identifier is always mono. */
  mono?: boolean | undefined;
  className?: string | undefined;
}

export function Monogram({ children, name, size = 28, tone = 'brand', mono, className = '' }: MonogramProps) {
  const style = MONOGRAM[size];
  const isMono = mono ?? style.mono;

  return (
    <span
      title={name}
      aria-hidden={name === undefined ? true : undefined}
      aria-label={name}
      role={name === undefined ? undefined : 'img'}
      className={[
        'grid flex-none place-items-center',
        style.box,
        style.weight,
        isMono ? 'font-mono' : '',
        TONE[tone],
        className,
      ].join(' ')}
    >
      {children}
    </span>
  );
}
