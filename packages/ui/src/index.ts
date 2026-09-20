// @relayd/ui — the shell and the components on the design-system sheet, built
// once and reused on every page (CLAUDE.md section 15).
//
// Tokens are `./tokens.css`, imported by apps/web/src/index.css. Everything
// here is presentational and router-agnostic; apps/web wires the Link.

export { ICON_PATHS, Icon } from './icons.js';
export type { IconName, IconProps } from './icons.js';

export {
  TONES,
  CAMPAIGN_STATES,
  RECIPIENT_STATES,
  CONTACT_STATES,
  HEALTH,
  stateStyle,
} from './states.js';
export type {
  Tone,
  StateStyle,
  CampaignState,
  RecipientState,
  ContactState,
  Health,
} from './states.js';

export { Badge, StateBadge } from './Badge.js';
export type { BadgeProps } from './Badge.js';

export { Button } from './Button.js';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button.js';

export { Field, PasswordField, inputClass } from './Field.js';
export type { FieldProps, FieldSize } from './Field.js';

export { Shell, BrandMark, NAV } from './Shell.js';
export type {
  ShellProps,
  ShellWorkspace,
  ShellUser,
  ShellUsage,
  ShellBanner,
  NavGroup,
  NavItem,
  LinkProps,
} from './Shell.js';

export { AuthLayout } from './AuthLayout.js';
export type { AuthLayoutProps } from './AuthLayout.js';

export { initialTheme, applyTheme, currentTheme, toggleTheme, readStoredTheme } from './theme.js';
export type { Theme } from './theme.js';
