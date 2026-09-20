import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button, ErrorState, PageHeader } from '@relayd/ui';
import { errorMeta, requestIdOf } from '../../query-client.js';
import { LinkButton } from './link-button.js';

/**
 * K4d — the generic error, with the request ID in mono.
 *
 * The frame is K4d "Generic error /reports": the page's own header is still
 * drawn (the user has to know which page failed), and the body is the error
 * card. Every word of the card is `ErrorState`'s default, because the
 * defaults were taken from this frame.
 *
 * The request ID is the reason this page exists. `requestIdOf()` reads it
 * off the error envelope the API client parsed, so support can join what
 * the user saw to a server trace. When the failure never reached the server
 * there is no ID and the chip is simply not drawn — an invented one would
 * be worse than none, because support would search for it.
 *
 * "Status page" is an anchor to `#`, exactly as the export writes it: there
 * is no status site in this build, and pointing it at a route that would
 * 404 is a worse lie than the one the design already tells (the same
 * reasoning as `routes/public/chrome.tsx`).
 */

export interface ErrorPageProps {
  /** The page's own title, so the user knows what failed. */
  title?: ReactNode | undefined;
  description?: ReactNode | undefined;
  /** The rejection, for its request ID and status. */
  error?: unknown;
  onRetry?: (() => void) | undefined;
}

export function ErrorPage({ title = 'Something went wrong', description, error, onRetry }: ErrorPageProps) {
  const requestId = requestIdOf(error);

  return (
    <>
      <PageHeader title={title} {...(description === undefined ? {} : { description })} />
      <ErrorState
        {...(requestId === undefined ? {} : { requestId })}
        meta={errorMeta(error)}
        actions={
          <>
            <LinkButton href="#">Status page</LinkButton>
            <Button variant="secondary" onClick={() => contactSupport(requestId)}>
              Contact support
            </Button>
          </>
        }
        {...(onRetry === undefined ? {} : { onRetry })}
      />
    </>
  );
}

/**
 * Support gets the request ID without the user having to copy it across.
 * A `mailto:` rather than a widget: this app has no support widget, and an
 * address is the one channel that works with no further build.
 */
function contactSupport(requestId: string | undefined): void {
  const subject = requestId === undefined ? 'Relayd support' : `Relayd support · ${requestId}`;
  window.location.assign(`mailto:support@relayd.io?subject=${encodeURIComponent(subject)}`);
}

/* ------------------------------------------------------------------ */
/* The boundary the shell wraps its outlet in                          */
/* ------------------------------------------------------------------ */

interface BoundaryProps {
  /** Changes when the route does, which resets a caught error. */
  resetKey: string;
  title: ReactNode;
  onRetry: () => void;
  children: ReactNode;
}

interface BoundaryState {
  error: unknown;
  key: string;
}

/**
 * A render that throws inside the shell becomes K4d instead of a blank page.
 *
 * `<Routes>` is not a data router, so there is no `errorElement` to hand
 * this to; the shell wraps its own `<Outlet />` and the page keeps its
 * navigation, which is what K4d draws. A route change clears the error:
 * without that, one broken page would follow the user around the app.
 */
export class RouteErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Sentry is wired in a later phase (CLAUDE.md section 2); `console` is
    // banned in apps/** by relayd/no-console, so this deliberately reports
    // nowhere yet rather than reporting somewhere wrong.
    void error;
    void info;
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;

    return (
      <ErrorPage
        title={this.props.title}
        error={this.state.error}
        onRetry={() => {
          this.setState({ error: null });
          this.props.onRetry();
        }}
      />
    );
  }
}

/** The preview route for K4d, and what a section's own query failure looks like. */
export function ErrorPreviewPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  return (
    <ErrorPage
      title="Reports"
      description="Cross-campaign analytics for this workspace."
      error={{ status: 502, requestId: 'req_01J9K4ERR7Q2M8' }}
      onRetry={() => void navigate(pathname, { replace: true })}
    />
  );
}
