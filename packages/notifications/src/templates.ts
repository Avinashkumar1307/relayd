/**
 * Product email: verification, invitations, password reset, dunning.
 *
 * These are NOT customer campaigns and never share a code path with them.
 * docs/10: "SES for transactional product email, in a separate account
 * identity from any customer's. Never send product email through a customer's
 * provider." A customer whose SES account is suspended must still be able to
 * receive a password-reset email, and a customer must never be billed for one.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Escapes text for interpolation into HTML.
 *
 * Every value here is user-controlled — a workspace name, a display name —
 * and product email lands in inboxes that render HTML. docs/06 sanitises
 * campaign templates against an allowlist; these templates take the simpler
 * route of escaping everything, because none of them accepts markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const layout = (heading: string, body: string, action?: { label: string; url: string }): string => `
<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f6f7f9;font-family:system-ui,-apple-system,sans-serif">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px">
      <h1 style="font-size:20px;color:#0f172a;margin:0 0 16px">${escapeHtml(heading)}</h1>
      <div style="font-size:15px;line-height:1.6;color:#334155">${body}</div>
      ${
        action === undefined
          ? ''
          : `<p style="margin:24px 0">
               <a href="${escapeHtml(action.url)}"
                  style="display:inline-block;background:#0f172a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">
                 ${escapeHtml(action.label)}
               </a>
             </p>
             <p style="font-size:13px;color:#64748b">
               If the button does not work, paste this into your browser:<br>
               ${escapeHtml(action.url)}
             </p>`
      }
    </div>
  </body>
</html>`;

export function emailVerification(input: { verifyUrl: string }): RenderedEmail {
  return {
    subject: 'Confirm your email address',
    text: [
      'Confirm your email address to finish setting up your Relayd account.',
      '',
      input.verifyUrl,
      '',
      'This link expires in 24 hours. If you did not create an account, ignore this email.',
    ].join('\n'),
    html: layout(
      'Confirm your email address',
      '<p>Confirm your email address to finish setting up your Relayd account.</p>' +
        '<p>This link expires in 24 hours. If you did not create an account, you can ignore this email.</p>',
      { label: 'Confirm email', url: input.verifyUrl },
    ),
  };
}

export function passwordReset(input: { resetUrl: string }): RenderedEmail {
  return {
    subject: 'Reset your password',
    text: [
      'Someone asked to reset the password for your Relayd account.',
      '',
      input.resetUrl,
      '',
      'This link expires in one hour and can be used once.',
      'If this was not you, no action is needed — your password has not changed.',
    ].join('\n'),
    html: layout(
      'Reset your password',
      '<p>Someone asked to reset the password for your Relayd account.</p>' +
        '<p>This link expires in one hour and can be used once. If this was not you, ' +
        'no action is needed and your password has not changed.</p>',
      { label: 'Reset password', url: input.resetUrl },
    ),
  };
}

export function workspaceInvitation(input: {
  workspaceName: string;
  acceptUrl: string;
}): RenderedEmail {
  return {
    subject: `You have been invited to ${input.workspaceName} on Relayd`,
    text: [
      `You have been invited to join ${input.workspaceName} on Relayd.`,
      '',
      input.acceptUrl,
      '',
      'This invitation expires in 7 days and must be accepted from the address it was sent to.',
    ].join('\n'),
    html: layout(
      `You have been invited to ${input.workspaceName}`,
      `<p>You have been invited to join <strong>${escapeHtml(input.workspaceName)}</strong> on Relayd.</p>` +
        '<p>This invitation expires in 7 days, and must be accepted from the address it was sent to.</p>',
      { label: 'Accept invitation', url: input.acceptUrl },
    ),
  };
}
