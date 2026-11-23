// The parts of core that load without the macOS native bindings, for short-lived callers such as the CLI.
// The full entry (index.ts) evaluates the FFI modules, which costs most of a CLI command's startup time.
import "./env-compat.js";
export type { HistoryDocument } from "./passive-memory/history-events.js";
export { type HistorySkillDetection, describeHistoryStep } from "./passive-memory/history-skill-candidates.js";
export { suggestHistorySkills } from "./passive-memory/history-skill-store.js";
export {
	type HistoryPaths,
	historyPaths,
	readHistoryState,
	writeHistoryState,
} from "./passive-memory/history-control.js";
export {
	DEFAULT_RAW_RETENTION_HOURS,
	type HistoryDeletion,
	type HistorySegmentSummary,
	deleteHistorySegments,
	isHistorySegmentId,
	listHistorySegments,
	parseHistoryDuration,
	readRawRetentionMs,
} from "./passive-memory/history-management.js";
export {
	type HistoryClearResult,
	type HistoryMemory,
	type HistoryMemoryGenerator,
	type HistoryMemorySkill,
	type HistorySession,
	type HistorySummarizeOptions,
	type HistorySummarizeResult,
	clearHistory,
	historyMemoriesDir,
	listHistoryMemories,
	sessionizeHistory,
	summarizeHistory,
} from "./passive-memory/history-memories.js";
export {
	SKILL_DESCRIPTIONS_FILE,
	type SkillDescription,
	type SkillDescriptionGenerator,
	describeSkillCandidates,
	parseSkillDescription,
	readSkillDescriptions,
	readSkippedSkillCandidates,
	setSkillDescriptionsEnabled,
	skillDescriptionPrompt,
	skillDescriptionsEnabled,
} from "./passive-memory/history-skill-descriptions.js";
export { resolveHistoryRecorderBinary } from "./passive-memory/history-recorder-binary.js";
export {
	DEFAULT_LEASE_MS,
	LEASE_HOLDER_ENV,
	LEASE_TOOLS,
	type LeaseTool,
	MAX_LEASE_MS,
	type WindowLease,
	appendLeaseAudit,
	parseLeaseHolder,
	readLeases,
	writeLeases,
} from "./computer/window-lease.js";
export { AppApprovalStore } from "./permission/app-approval.js";
export { isBrowserBundle } from "./permission/url-blocklist.js";
export {
	IPHONE_MIRRORING_APP_NAME,
	type MirroringSessionState,
	describeMirroringState,
} from "./platform/ios-mirroring-state.js";
export {
	CURSOR_MOTION_ENV,
	type CursorMotionConfig,
	cursorMotionFromEnvironment,
	parseCursorMotion,
} from "./platform/macos-ffi/cursor-motion-config.js";
export { StopSwitch, type StopStatusSource, describeUserStop, resolveStateDir } from "./platform/stop-switch.js";
export {
	type ActivityEntry,
	ActivityFeed,
	type ActivityState,
	type ComposedActivity,
	activityFeedDir,
	activityHudDisabled,
	buddyHudBinary,
	composeActivity,
	defaultActivityFeed,
	hudStarter,
} from "./platform/activity-feed.js";
