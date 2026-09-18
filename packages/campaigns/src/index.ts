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
