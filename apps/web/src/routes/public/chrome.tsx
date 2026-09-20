import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { BrandMark } from '@relayd/ui';

/**
 * The public header and footer (design/A Public.dc.html, frames A1 and A2).
 *
 * Section A is the only part of the app that is not inside the shell: it has
 * "own light header (wordmark, Pricing, Docs, Sign in, Get started) and navy
 * footer; no app shell" (the section note in the design index). Both frames
 * draw the same header and two shapes of the same footer, so both are built
 * once here.
 *
 * The navy is not a one-off colour: `--sidebar`, `--sidebar-text` and
 * `--sidebar-muted` in `tokens.css` are exactly the `#141B3D` / `#C9CFEA` /
 * `#7C86B8` the footer uses, because the sidebar is the same navy in both
 * themes. That is why the footer looks identical in dark mode, which is what
 * the frames show.
 *
 * Links that have no destination in the design are `href="#"` here, exactly
 * as the export writes them. There is no docs site and no marketing sub-page
 * in this build, and pointing them at routes that would 404 would be a
 * worse lie than the one the design already tells.
 */

/** 72px tall, 64px side padding, wordmark left, actions right. */
export function PublicHeader() {
  return (
    <header className="flex h-[72px] items-center justify-between gap-4 border-b border-border px-6 md:px-16">
      <Link to="/" className="flex items-center gap-2.5 text-text no-underline">
        <BrandMark size={32} />
        <span className="text-[18px] font-semibold tracking-heading">Relayd</span>
      </Link>

      <nav className="hidden items-center gap-7 text-body font-medium sm:flex">
        <NavLink
          to="/pricing"
          className={({ isActive }) => `no-underline ${isActive ? 'text-text' : 'text-text-2'}`}
        >
          Pricing
        </NavLink>
        <a href="#" className="text-text-2 no-underline">
          Docs
        </a>
      </nav>

      <div className="flex items-center gap-2.5">
        <Link
          to="/login"
          className="inline-flex h-[38px] items-center rounded-control px-3.5 text-body font-medium text-text no-underline"
        >
          Sign in
        </Link>
        <Link
          to="/register"
          className="inline-flex h-[38px] items-center rounded-control bg-brand px-4 text-body font-medium text-white no-underline hover:bg-brand-hover"
        >
          Get started
        </Link>
      </div>
    </header>
  );
}

const FOOTER_COLUMNS: { title: string; links: { label: string; to?: string }[] }[] = [
  {
    title: 'Product',
    links: [{ label: 'Campaigns' }, { label: 'Audience' }, { label: 'Analytics' }, { label: 'Sending pools' }],
  },
  {
    title: 'Developers',
    links: [{ label: 'API reference' }, { label: 'Webhooks' }, { label: 'Merge tags' }, { label: 'Status' }],
  },
  {
    title: 'Company',
    links: [{ label: 'About' }, { label: 'Pricing', to: '/pricing' }, { label: 'Security' }, { label: 'Contact' }],
  },
  {
    title: 'Legal',
    links: [{ label: 'Privacy' }, { label: 'Terms' }, { label: 'DPA' }, { label: 'Acceptable use' }],
  },
];

const COPYRIGHT = '© 2026 Relayd Ltd · Data hosted in the EU (Frankfurt)';

function FooterLink({ label, to }: { label: string; to?: string | undefined }) {
  if (to === undefined) {
    return (
      <a href="#" className="text-sidebar-text no-underline hover:text-white">
        {label}
      </a>
    );
  }

  return (
    <Link to={to} className="text-sidebar-text no-underline hover:text-white">
      {label}
    </Link>
  );
}

function FooterWordmark() {
  return (
    <span className="flex items-center gap-2.5 text-white">
      <BrandMark size={28} />
      <span className="text-card font-semibold">Relayd</span>
    </span>
  );
}

/**
 * `full` is A1's five-column footer; `compact` is A2's single row.
 */
export function PublicFooter({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  if (variant === 'compact') {
    return (
      <footer className="flex flex-col items-start justify-between gap-4 bg-sidebar px-6 pt-10 pb-8 text-ui text-sidebar-text md:flex-row md:items-center md:px-16">
        <FooterWordmark />
        <span className="text-sidebar-muted">{COPYRIGHT} · GDPR · DPA available</span>
        <span className="flex gap-5">
          <FooterLink label="Privacy" />
          <FooterLink label="Terms" />
          <FooterLink label="Status" />
        </span>
      </footer>
    );
  }

  return (
    <footer className="bg-sidebar px-6 pt-14 pb-8 text-sidebar-text md:px-16">
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))]">
        <div>
          <FooterWordmark />
          <p className="mt-3.5 max-w-[280px] text-ui text-sidebar-muted">
            Email campaign orchestration on top of your own provider account.
          </p>
        </div>

        {FOOTER_COLUMNS.map((column) => (
          <div key={column.title}>
            <div className="text-caption font-semibold tracking-label uppercase text-sidebar-muted">
              {column.title}
            </div>
            <ul className="mt-3.5 flex list-none flex-col gap-2 p-0 text-body">
              {column.links.map((link) => (
                <li key={link.label}>
                  <FooterLink label={link.label} to={link.to} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-12 flex flex-col gap-4 border-t border-sidebar-line pt-6 text-ui text-sidebar-muted sm:flex-row sm:items-center sm:justify-between">
        <span>{COPYRIGHT}</span>
        <span className="flex gap-5">
          <span>GDPR</span>
          <span>DPA available</span>
          <span>Status</span>
        </span>
      </div>
    </footer>
  );
}

/** Header, page, footer — the frame of every public page. */
export function PublicPage({
  children,
  footer = 'full',
}: {
  children: ReactNode;
  footer?: 'full' | 'compact';
}) {
  return (
    <div className="min-h-screen bg-surface text-text">
      <PublicHeader />
      <main>{children}</main>
      <PublicFooter variant={footer} />
    </div>
  );
}
