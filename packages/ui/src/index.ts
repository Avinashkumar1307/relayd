// @relayd/ui - the shell and the components on the design-system sheet, built
// once and reused on every page (CLAUDE.md section 15).
//
// Tokens are `./tokens.css`, imported by apps/web/src/index.css. Everything
// here is presentational and router-agnostic: the shell takes a `Link`
// component and a `currentPath` rather than importing React Router, so every
// piece renders in a test without one.
//
// This file is generated from what the modules actually export, so a
// component that exists is always reachable. `overlay.ts`'s focus plumbing
// and `field-parts.tsx`'s FieldFrame are deliberately not re-exported: they
// are how these components are built, not what the app composes with.

// ---- tokens, state vocabulary and icons --------------------------------
export { ICON_PATHS, Icon } from './icons.js';
export type { IconName, IconProps } from './icons.js';
export { CAMPAIGN_STATES, CONTACT_STATES, HEALTH, RECIPIENT_STATES, TONES, stateStyle } from './states.js';
export type { CampaignState, ContactState, Health, RecipientState, StateStyle, Tone } from './states.js';
export {
  applyTheme,
  currentTheme,
  initialTheme,
  readStoredPreference,
  readStoredTheme,
  resolveTheme,
  setThemePreference,
  toggleTheme,
  useThemePreference,
} from './theme.js';
export type { Theme, ThemePreference, ThemePreferenceState } from './theme.js';

// ---- layout: the shell and the auth frame ------------------------------
export { BrandMark, NAV, Shell } from './Shell.js';
export type { LinkProps, NavGroup, NavItem, ShellBanner, ShellProps, ShellUsage, ShellUser, ShellWorkspace } from './Shell.js';
export { AuthLayout } from './AuthLayout.js';
export type { AuthLayoutProps } from './AuthLayout.js';
export { PageHeader } from './PageHeader.js';
export type { PageHeaderProps } from './PageHeader.js';
export { CARD_SURFACE, Card, CardHeader, Stat, TONE_TEXT } from './Card.js';
export type { CardHeaderProps, CardProps, StatProps } from './Card.js';

// ---- controls ----------------------------------------------------------
export { Button } from './Button.js';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button.js';
export { Field, PasswordField, inputClass } from './Field.js';
export type { FieldProps, FieldSize } from './Field.js';
export { Select } from './Select.js';
export type { SelectProps } from './Select.js';
export { Textarea } from './Textarea.js';
export type { TextareaProps } from './Textarea.js';
export { Checkbox } from './Checkbox.js';
export type { CheckboxProps, CheckboxSize } from './Checkbox.js';
export { Radio, RadioCard, RadioGroup } from './Radio.js';
export type { RadioCardProps, RadioGroupProps, RadioProps } from './Radio.js';
export { Switch } from './Switch.js';
export type { SwitchProps } from './Switch.js';
export { SearchInput } from './SearchInput.js';
export type { SearchInputProps, SearchInputSize } from './SearchInput.js';
export { ThemeControl } from './ThemeControl.js';
export type { ThemeControlProps, ThemeControlVariant } from './ThemeControl.js';

// ---- identity and secrets ----------------------------------------------
export { Badge, StateBadge } from './Badge.js';
export type { BadgeProps } from './Badge.js';
export { Avatar, Monogram } from './Avatar.js';
export type { AvatarProps, AvatarSize, AvatarTone, MonogramProps, MonogramSize } from './Avatar.js';
export { Mono } from './Mono.js';
export type { MonoProps } from './Mono.js';
export { CopyButton } from './CopyButton.js';
export type { CopyButtonProps, CopyButtonSize } from './CopyButton.js';
export { RevealOnce } from './RevealOnce.js';
export type { RevealOnceProps, RevealPhase } from './RevealOnce.js';

// ---- data display ------------------------------------------------------
export { BulkBar, DataTable } from './Table.js';
export type { BulkAction, BulkBarProps, Column, ColumnAlign, DataTableProps, SortDirection } from './Table.js';
export { Tabs } from './Tabs.js';
export type { TabItem, TabsProps } from './Tabs.js';
export { SEG_ORDER, SegmentedBar, fmtCount, segmentValues } from './SegmentedBar.js';
export type { SegmentCounts, SegmentDefinition, SegmentKey, SegmentedBarProps } from './SegmentedBar.js';
export { EmptyState } from './EmptyState.js';
export type { EmptyStateProps } from './EmptyState.js';
export { ErrorState } from './ErrorState.js';
export type { ErrorStateProps } from './ErrorState.js';
export { DashboardSkeleton, DetailSkeleton, Skeleton, TableSkeleton } from './Skeleton.js';
export type { SkeletonProps, SkeletonShape, TableSkeletonProps } from './Skeleton.js';

// ---- overlays and messaging --------------------------------------------
export { Modal } from './Modal.js';
export type { ModalProps, ModalSize } from './Modal.js';
export { Drawer } from './Drawer.js';
export type { DrawerProps, DrawerSize } from './Drawer.js';
export { ConfirmDestructive } from './ConfirmDestructive.js';
export type { ConfirmDestructiveProps } from './ConfirmDestructive.js';
export { Stepper } from './Stepper.js';
export type { StepperProps, StepperStep, StepperVariant } from './Stepper.js';
export { Menu } from './Menu.js';
export type { MenuItem, MenuItemTone, MenuProps } from './Menu.js';
export { TOAST_DURATION, Toast, ToastProvider, useToast } from './Toast.js';
export type { ToastApi, ToastOptions, ToastProps, ToastRecord, ToastTone } from './Toast.js';
export { BANNERS, BANNER_ORDER, Banner } from './Banner.js';
export type { BannerContract, BannerDefinition, BannerKey, BannerProps, BannerTone } from './Banner.js';
export { SCRIM } from './overlay.js';
export type { DialogBehaviour } from './overlay.js';
