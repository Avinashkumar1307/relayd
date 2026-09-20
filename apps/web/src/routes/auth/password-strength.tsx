/**
 * The four-segment strength meter under the password field on B2 and B4b.
 *
 * The scoring is the export's, transcribed exactly (design/B Auth &
 * onboarding.dc.html, `const strength`): one point each for twelve
 * characters, mixed case, a digit and a symbol; anything under eight
 * characters is capped at one point; three points is the bar the "Create
 * account" and "Reset password" buttons unlock at.
 *
 * It is a *hint*, not a rule. `passwordSchema` in @relayd/validation is the
 * rule — twelve characters, nothing else — and the server enforces it. This
 * only decides what the meter says and, per the frames, when the submit
 * button stops being disabled.
 */

export interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  /** Score 3 or better: what the frames' primary button waits for. */
  ok: boolean;
  label: string;
  hint: string;
}

const LABELS = ['', 'Too weak', 'Weak', 'Good', 'Strong'] as const;

export function strengthOf(password: string): Strength {
  const length = password.length;
  let score = 0;

  if (length >= 12) score += 1;
  if (/[A-Z]/u.test(password) && /[a-z]/u.test(password)) score += 1;
  if (/\d/u.test(password)) score += 1;
  if (/[^A-Za-z0-9]/u.test(password)) score += 1;

  if (length === 0) score = 0;
  else if (length < 8) score = Math.min(score, 1);

  const missing: string[] = [];
  if (length < 12) missing.push(`${Math.max(0, 12 - length)} more characters`);
  else {
    if (!/[A-Z]/u.test(password) || !/[a-z]/u.test(password)) missing.push('mixed case');
    if (!/\d/u.test(password)) missing.push('a number');
    if (!/[^A-Za-z0-9]/u.test(password)) missing.push('a symbol');
  }

  const hint =
    length === 0
      ? '12+ characters, mixed case, a number'
      : score >= 3
        ? score === 4
          ? 'Great'
          : 'Add a symbol for strong'
        : `Needs ${missing.join(', ')}`;

  return {
    score: score as Strength['score'],
    ok: score >= 3,
    label: length === 0 ? 'Strength' : (LABELS[score] ?? 'Strength'),
    hint,
  };
}

/** Segment fill and label colour by score — #DC2626 / #F59E0B / #10B981. */
const FILL = ['bg-border', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'] as const;
const LABEL_TEXT = [
  'text-text-2',
  'text-danger-text',
  'text-warning-text',
  'text-success-text',
  'text-success-text',
] as const;

export function PasswordStrength({ password }: { password: string }) {
  const { score, label, hint } = strengthOf(password);

  // One element, because it is passed as a `Field`'s `help` slot — which is
  // the position the frames draw it in, directly under the input and inside
  // the label's own 6px column.
  return (
    <span className="flex flex-col gap-1.5">
      <span className="mt-0.5 grid grid-cols-4 gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className={`h-1 rounded-2 ${index < score ? (FILL[score] ?? 'bg-neutral-soft') : 'bg-neutral-soft'}`}
          />
        ))}
      </span>
      <span className="flex justify-between gap-3 text-caption">
        <span className={`font-medium ${LABEL_TEXT[score] ?? 'text-text-2'}`}>{label}</span>
        <span className="text-right text-text-2">{hint}</span>
      </span>
    </span>
  );
}
