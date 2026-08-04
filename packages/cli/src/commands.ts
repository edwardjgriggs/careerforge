/** Public command surface; implementations are grouped by responsibility. */
export type { CommandResult } from './command-runtime.js';
export {
  COLLECTOR_NAMES,
  collect,
  explain,
  exportCommand,
  group,
  init,
  interview,
  isCollectorName,
  rebuild,
  reindex,
  search,
  timeline,
  units,
  type CollectOptions,
  type GroupCommandOptions,
  type InterviewOptions,
  type UnitsOptions,
} from './local-commands.js';
export {
  consent,
  enrich,
  enrichments,
  payloadForUnit,
  previewEgress,
  type ConsentOptions,
  type EnrichOptions,
  type EnrichmentsOptions,
  type PreviewOptions,
} from './ai-commands.js';
export {
  assets,
  generate,
  review,
  type AssetsOptions,
  type GenerateOptions,
  type ReviewOptions,
} from './asset-commands.js';
export { ui, type UiOptions } from './ui-command.js';
