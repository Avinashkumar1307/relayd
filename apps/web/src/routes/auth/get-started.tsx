import { Skeleton } from '@relayd/ui';
import { useAuth } from '../../auth/AuthProvider.js';
import { useWorkspaceRecord } from '../../auth/workspace-state.js';
import { OnboardingChecklist, useOnboardingProgress } from '../../components/onboarding-checklist.js';

/**
 * B6b Onboarding checklist /get-started — step 2 of 2, B6a being step 1.
 *
 * The page is a header, a progress bar and the checklist card. The card is
 * `OnboardingChecklist`, because the dashboard shows the same four steps in
 * its compact form (C3) and two copies of "what is left to set up" would
 * drift apart the first time a step changed.
 *
 * Nothing here is stored. Every step is derived from the collection endpoint
 * that answers it — see the note on `useOnboardingProgress` — so a workspace
 * that connected a provider in another tab sees this page catch up on its
 * next fetch rather than showing a stale server-side flag.
 *
 * The banner the frame draws above this page ("New account sending cap: 500
 * emails/day") is the shell's, not the page's: K1d, raised from the
 * workspace record for every page while the cap applies.
 */

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "24 Sep" — how the frame writes the date the cap lifts. */
function capDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.getUTCDate()} ${MONTH[date.getUTCMonth()] ?? ''}`;
}

export function GetStartedPage() {
  const { current } = useAuth();
  const { completed, total, loading } = useOnboardingProgress();
  const workspace = useWorkspaceRecord();

  const name = current?.workspaceName ?? workspace.data?.name ?? 'your workspace';
  const capLiftsOn = capDate(workspace.data?.alerts?.newAccountCap?.endsAt);
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

  return (
    <div className="mx-auto w-full max-w-[760px]">
      <div className="mb-6">
        <div className="mb-2 text-caption font-medium text-text-2">Step 2 of 2</div>
        <h1 className="m-0 text-title font-semibold leading-heading tracking-heading">
          Get {name} ready to send
        </h1>
        <p className="mb-0 mt-1.5 text-text-2 text-pretty">
          Four steps, in order. Relayd never sends through its own servers, so a provider connection and a
          verified sender come first.
        </p>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-3 bg-neutral-soft">
          <div
            className="h-full rounded-3 bg-brand transition-[width]"
            style={{ width: `${loading ? 0 : percent}%` }}
          />
        </div>
        {loading ? (
          <Skeleton width={96} height={13} />
        ) : (
          <span className="whitespace-nowrap text-ui text-text-2">
            {completed} of {total} complete
          </span>
        )}
      </div>

      <OnboardingChecklist capLiftsOn={capLiftsOn} />
    </div>
  );
}
