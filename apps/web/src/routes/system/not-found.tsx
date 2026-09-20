import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Icon } from '@relayd/ui';
import { useAuth } from '../../auth/AuthProvider.js';
import { PublicFooter, PublicHeader } from '../public/chrome.js';
import { LinkButton } from './link-button.js';

/**
 * A4 — not found, and the page another workspace's resource reaches.
 *
 * CLAUDE.md section 11: "Non-members receive 404 for another workspace's
 * resource, never 403." The frame says so in the copy, on purpose — "Relayd
 * shows the same page in both cases" — because a 403 would confirm the
 * resource exists, and a user who lands here needs to know the page is not
 * telling them which of the two happened.
 *
 * Outside the shell, on section A's public chrome: the export draws A4 with
 * the marketing header and the navy footer, not the sidebar, because
 * whoever reaches it may not be signed in at all.
 */

export function NotFound() {
  const { pathname } = useLocation();
  const requestId = useRequestId();

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <div className="bg-surface">
        <PublicHeader />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <span className="font-mono text-ui text-text-3">404</span>

        <h1 className="mt-3 text-[40px] leading-[1.1] font-semibold tracking-[-0.025em]">
          We can&apos;t find that page
        </h1>

        <p className="mt-3.5 max-w-130 text-[17px] text-pretty text-text-2">
          It may have moved, or it belongs to a workspace you don&apos;t have access to. Relayd shows the same page
          in both cases.
        </p>

        <span className="mt-5 inline-flex h-8 max-w-full items-center gap-2 overflow-hidden rounded-control border border-border bg-surface px-3 font-mono text-ui text-text-2">
          <span className="truncate">
            {window.location.host}
            {pathname}
          </span>
        </span>

        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <LinkButton to="/dashboard" variant="primary" size="lg">
            Go to your dashboard
          </LinkButton>
          <SwitchWorkspace />
        </div>

        <p className="mt-7 text-ui text-text-3">
          Need access? Ask an Owner or Admin of that workspace to invite you.
          {requestId === null ? null : (
            <>
              {' '}
              Request ID <span className="font-mono">{requestId}</span>
            </>
          )}
        </p>
      </div>

      <PublicFooter variant="compact" />
    </div>
  );
}

/**
 * The frame's second action.
 *
 * There is no standalone "switch workspace" route — the switcher is a
 * popover in the shell's sidebar, and the shell is the one thing this page
 * does not have. So the list is drawn here, small, and picking a workspace
 * switches and lands on its dashboard. With nothing to switch to the button
 * stays and says why, which is the sheet's rule for a disabled control.
 */
function SwitchWorkspace() {
  const { memberships, currentWorkspaceId, switchWorkspace, status } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const others = memberships.filter((membership) => membership.workspaceId !== currentWorkspaceId);
  const reason =
    status !== 'authenticated'
      ? 'Sign in to switch workspace'
      : others.length === 0
        ? 'You are a member of one workspace'
        : undefined;

  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        type="button"
        disabled={reason !== undefined}
        title={reason}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={[
          'inline-flex h-11 items-center justify-center gap-1.5 rounded-control border px-4.5 text-[15px] font-medium',
          'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft',
          reason === undefined
            ? 'cursor-pointer border-border bg-surface text-text hover:bg-tint'
            : 'cursor-not-allowed border-transparent bg-neutral-soft text-text-3',
        ].join(' ')}
      >
        Switch workspace
        {reason === undefined ? <Icon name="chevronDown" size={14} strokeWidth={2} /> : null}
      </button>

      {!open ? null : (
        <span
          role="listbox"
          aria-label="Workspaces"
          className="absolute top-[calc(100%+6px)] left-1/2 z-10 block w-70 -translate-x-1/2 rounded-card border border-border bg-surface p-1.5 text-left shadow-overlay"
        >
          {others.map((membership) => (
            <button
              key={membership.workspaceId}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => {
                setOpen(false);
                switchWorkspace(membership.workspaceId);
                void navigate('/dashboard');
              }}
              className="block w-full cursor-pointer truncate rounded-control px-2.5 py-2 text-left text-ui font-medium hover:bg-tint"
            >
              {membership.workspaceName}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * The request ID, when the server is the one that said no.
 *
 * A client-side 404 — a URL nobody ever asked the API about — has no trace
 * to quote, so the line is drawn without one. A page that routes here after
 * a 404 from the API passes the id in the navigation state.
 */
function useRequestId(): string | null {
  const { state } = useLocation();
  const candidate = (state as { requestId?: unknown } | null)?.requestId;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}
