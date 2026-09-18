// @relayd/campaigns — launch, snapshot, dispatch, state machine, rendering.
export { sanitiseTemplateHtml, filterStyle } from './templates/sanitise.js';
export type { SanitiseResult } from './templates/sanitise.js';
export {
  discoverMergeTags,
  renderMergeTags,
  escapeHtml,
  contactValues,
  unresolvableTags,
  CONTACT_FIELDS,
} from './templates/merge-tags.js';
export type { MergeTag, RenderContext, EscapeMode } from './templates/merge-tags.js';
export { compileTemplate, renderTemplate, htmlToText } from './templates/render.js';
export type { CompileInput, CompiledTemplate, RenderedMessage } from './templates/render.js';

export { launchCampaign, LAUNCHABLE_STATES } from './engine/launch.js';
export type { LaunchPort, LaunchableCampaign, LaunchResult, LaunchFailure } from './engine/launch.js';
export { sendOne, classifyForSend, messageIdFor } from './engine/send.js';
export type {
  SendPort,
  SendableRecipient,
  SendResult,
  SendOutcomeKind,
  ProviderCall,
  ProviderCallResult,
} from './engine/send.js';
