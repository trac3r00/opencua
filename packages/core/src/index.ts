import "./env-compat.js";
export type * from "./accessibility/types.js";
export { classifyContentKind, type ContentKind } from "./accessibility/content-kind.js";
export { diffAxTreeChanges, type AxTreeChanges } from "./accessibility/diff.js";
export {
	type ElementMatch,
	type ElementQuery,
	describeQuery,
	matchElements,
	suggestNearMisses,
} from "./accessibility/element-query.js";
export {
	AX_PRESS_ACTION,
	axScrollActionFor,
	clickPoint,
	findMatchingApp,
	getAppStateForApp,
	normalizeModifiers,
	observeAction,
	parseElementIndex,
	parseKeyChord,
	pressElement,
	resolveAppPid,
	resolvePointForElement,
	scrollElement,
	withTargetedApp,
	type ComputerUseMouseButton,
} from "./computer/actions.js";
export { resolveScreenPoint } from "./computer/coordinate.js";
export {
	type CursorOwner,
	currentCursorIdentity,
	currentCursorOwner,
	inContextClick,
	withContextClick,
	withCursorIdentity,
} from "./computer/cursor-scope.js";
export {
	InputOutsideRegion,
	assertFocusInInputRegion,
	assertPointInInputRegion,
	currentInputRegion,
	withInputRegion,
} from "./computer/input-region.js";
export {
	HandsCoordinator,
	type HandName,
	type HandResource,
	type HandTask,
	type HandsPolicy,
	type HandLaneResult,
	type HandsRunOptions,
	type HandsRunResult,
} from "./computer/hands.js";
export {
	type InputScope,
	type InputTarget,
	InputInterrupted,
	currentInputScope,
	runInInputScope,
} from "./computer/input-scope.js";
export { pressKeySequence, type KeySequenceEntry, type KeySequenceOptions } from "./computer/key-sequence.js";
export {
	type SelectionMode,
	type SelectionRange,
	type SelectionRangeInput,
	resolveSelectionRange,
} from "./computer/select-text.js";
export type {
	GuardedComputerInterface,
	InputObservation,
	PreflightOptions,
	PreflightResult,
} from "./computer/guarded-interface.js";
export type { ComputerInterface, ScreenshotResult, WindowTextRead } from "./computer/interface.js";
export {
	type TopLevelWindow,
	type TopLevelWindowOptions,
	type WindowProbe,
	fillWindowTitles,
	listTopLevelWindows,
} from "./platform/macos-top-level-windows.js";
export { type ListedWindow, listWindows } from "./platform/macos-ffi/window-list.js";
export { captureWindowViaSck } from "./platform/macos-ffi/sckit.js";
export {
	type AxEventWaiter,
	type AxQuietOutcome,
	createAxEventWaiter,
	waitForAxQuiet,
} from "./platform/macos-ffi/ax-observer.js";
export {
	activeSpaceId,
	managedDisplaySpaces,
	spaceTypeFor,
	spacesForWindows,
	type ManagedDisplaySpaces,
	type SpaceInfo,
} from "./platform/macos-ffi/sls-spaces.js";
export {
	type SystemPrompt,
	type SystemPromptKind,
	classifySystemPrompts,
	currentSystemPrompts,
	setSystemPromptWindowSourceForTesting,
} from "./platform/system-prompts.js";
export {
	MAX_SCREENSHOT_LONG_EDGE,
	type ScreenshotViewport,
	resolveWindowScreenshotSize,
	screenRectToScreenshot,
	screenshotPointToScreen,
} from "./computer/viewport.js";
export { type AppApprovalDecision, AppApprovalStore } from "./permission/app-approval.js";
export { type InputLockRecord, InputLock } from "./platform/input-lock.js";
export {
	type SpawnStopMenu,
	type StopMenu,
	type StopMenuProcess,
	startStopMenu,
} from "./platform/stop-menu.js";
export {
	type HotFrame,
	type HotFrameSourceOptions,
	type HotFrameWorker,
	type HotFrameWorkerSpawner,
	HotFrameSource,
} from "./computer/hot-frames.js";
export { type LockScreenMonitorCallbacks, LockScreenMonitor } from "./platform/lock-screen-monitor.js";
export { type HostCapabilities, probeHostCapabilities } from "./platform/host-capabilities.js";
export { getSckitLoadError, isSckitAvailable } from "./platform/macos-ffi/sckit.js";
export {
	type AutomationStatus,
	automationPermission,
	automationStatusFromCode,
	requestAccessibility,
	requestInputMonitoring,
	requestScreenRecording,
} from "./platform/macos-ffi/permission-prompts.js";
export { isBrowserBundle } from "./permission/url-blocklist.js";
export {
	type PassiveMemoryConfig,
	type PassiveMemoryContext,
	shouldRecord,
} from "./passive-memory/exclusion-policy.js";
export {
	type SegmentSink,
	PassiveMemorySegmentWriter,
	fileSegmentSink,
} from "./passive-memory/segment-writer.js";
export type {
	HistoryApp,
	HistoryWindow,
	HistoryElement,
	HistoryAx,
	HistoryEvent,
	HistoryEventKind,
} from "./passive-memory/history-events.js";
export { encodeHistoryEvent } from "./passive-memory/history-events.js";
export {
	type ObservationDefaultBehavior,
	type ObservationRule,
	type AppObservationRule,
	type UrlObservationRule,
	type HistoryObservationSettings,
	type HistoryObservationContext,
	DEFAULT_HISTORY_OBSERVATION_SETTINGS,
	shouldObserve,
} from "./passive-memory/history-settings.js";
export {
	type HistoryFs,
	type SegmentMetadata,
	HistorySegmentStore,
	nodeHistoryFs,
	segmentIdForTimestamp,
	segmentStartMs,
	SEGMENT_WINDOW_MS,
	DEFAULT_RETENTION_MS,
} from "./passive-memory/history-store.js";
export {
	type HistoryRecorderState,
	type HistoryRecorderOptions,
	type RecordOutcome,
	type UnstampedHistoryEvent,
	HistoryRecorder,
} from "./passive-memory/history-recorder.js";
export {
	type HistoryObservationInput,
	appStateToHistory,
} from "./passive-memory/history-observation.js";
export {
	type HistorySampler,
	type CaptureTimer,
	type HistoryCaptureLoopOptions,
	HistoryCaptureLoop,
} from "./passive-memory/history-capture.js";
export {
	type HistoryState,
	type HistoryPaths,
	type HistoryControlFs,
	historyPaths,
	nodeHistoryControlFs,
	readHistoryState,
	writeHistoryState,
	readHistorySettings,
	writeHistorySettings,
} from "./passive-memory/history-control.js";
export {
	type HistoryDeletion,
	type HistorySegmentSummary,
	deleteHistorySegments,
	isHistorySegmentId,
	listHistorySegments,
	parseHistoryDuration,
} from "./passive-memory/history-management.js";
export {
	SKILL_DESCRIPTIONS_FILE,
	type SkillDescription,
	type SkillDescriptionGenerator,
	describeSkillCandidates,
	parseSkillDescription,
	readSkillDescriptions,
	setSkillDescriptionsEnabled,
	skillDescriptionPrompt,
	skillDescriptionsEnabled,
} from "./passive-memory/history-skill-descriptions.js";
export { resolveHistoryRecorderBinary } from "./passive-memory/history-recorder-binary.js";
export {
	type HistorySegmentEvents,
	type HistorySkillCandidate,
	type HistorySkillDetection,
	type HistorySkillDetectionOptions,
	type HistoryStep,
	type HistoryStepAction,
	describeHistoryStep,
	detectHistorySkillCandidates,
} from "./passive-memory/history-skill-candidates.js";
export {
	type HistorySkillDraft,
	readRecentHistorySegments,
	saveHistorySkillDraft,
	suggestHistorySkills,
	validateHistorySkillDraft,
} from "./passive-memory/history-skill-store.js";
export type { PermissionInterface, PermissionKind, PermissionStatus } from "./permission/interface.js";
export { MacOSPermissions } from "./permission/macos.js";
export { CloudComputer, type CloudComputerOptions } from "./platform/cloud.js";
export { UTM, UTMError, UTM_BUNDLE_ID, type UTMVirtualMachine, type UTMObservation } from "./platform/utm.js";
export { HostComputer, type HostComputerOptions } from "./platform/host.js";
export { MacOSHostComputer, type MacOSHostComputerOptions, agentCursorEnabled } from "./platform/macos.js";
export type { InputDelivery } from "./platform/macos-input.js";
export { invokeMenu, type InvokeMenuResult } from "./platform/macos-menu.js";
export {
	type AppLister,
	type AppOpenLauncher,
	type OpenApplicationOptions,
	type OpenApplicationResult,
	openApplication,
	openArguments,
	spawnOpenLauncher,
} from "./platform/macos-open-app.js";
export { setWindowFrame } from "./platform/macos-window-frame.js";
export {
	type DockAction,
	type DockSnapshot,
	type DockSource,
	createNativeDockSource,
} from "./platform/macos-dock.js";
export { type MenuExtraSnapshot, createNativeMenuExtrasSource } from "./platform/macos-menu-extras.js";
export {
	type TerminalApplication,
	type TerminalCapture,
	type TerminalCaptureOptions,
	type TerminalRunOptions,
	type TerminalRunResult,
	TerminalAutomationPermissionError,
	TerminalNotRunningError,
	createTerminalSession,
	dispatchTerminalCommand,
	findTerminal,
	readVisibleText,
	runAndCapture,
	runCommand,
} from "./platform/terminal-session.js";
export {
	type OcrBox,
	type OcrTextObservation,
	type RecognizeTextOptions,
	filterByMinimumConfidence,
	isVisionOcrAvailable,
	readImagePixelSize,
	recognizeTextInFile,
	recognizeTextInImage,
} from "./platform/macos-ffi/vision.js";
export {
	type StopSource,
	type StopStatus,
	type StopStatusSource,
	STATE_DIR_ENV,
	StopSwitch,
	describeUserStop,
	resolveStateDir,
} from "./platform/stop-switch.js";
export {
	type StopChordDetectorOptions,
	type StopChordTimer,
	STOP_CHORD_LABEL,
	STOP_CHORD_MASK,
	StopChordDetector,
	startStopChordDetector,
} from "./platform/stop-chord.js";
export { readHidModifierFlags } from "./platform/macos-ffi/event-flags.js";
export {
	type IOSDelivery,
	type IOSInputTarget,
	type IOSScrollOptions,
	type KeystrokePlanEntry,
	type SwipeKind,
	type SwipeOptions,
	comboParts,
	gesturePath,
	longPressMirroring,
	pressMirroringCombo,
	scrollMirroring,
	swipeDurationMs,
	swipeMirroring,
	tapMirroring,
	typeIntoMirroring,
	typingPlan,
} from "./platform/ios-input.js";
export {
	IPHONE_MIRRORING_APP_NAME,
	IPHONE_MIRRORING_BUNDLE_ID,
	type IPhoneMirroringOptions,
	type MirroringAxEntry,
	type MirroringFocusProbe,
	type MirroringObservation,
	type MirroringSessionState,
	type MirroringText,
	type MirroringWindow,
	IPhoneMirroring,
	activateMirroring,
	captureMirroringWindow,
	classifyMirroringSession,
	describeInterruption,
	describeMirroringState,
	findMirroringWindow,
	findTexts,
	isMirroringFrontmost,
	mirroringProcess,
	mirroringSessionStatus,
	mirroringWindowAxContent,
	observeMirroring,
	ocrTextsToScreenPoints,
	probeMirroringFocus,
	requireMirroringSession,
	requireMirroringWindow,
	requireMirroringWindowAt,
	selectMirroringWindow,
	toMirroringWindow,
	windowOwnsPoint,
} from "./platform/ios-mirroring.js";
export {
	type ClipboardWriteInput,
	type ClipboardWriteResult,
	readClipboard,
	writeClipboard,
} from "./platform/macos-ffi/pasteboard.js";
export {
	type PointerMode,
	type PointerOverlay,
	type CursorState,
	NOOP_POINTER_OVERLAY,
	createCursorOverlay,
} from "./platform/macos-ffi/cursor-overlay.js";
export {
	type CursorMotionConfig,
	type CursorMotionStyle,
	type CursorMotionTiming,
	CURSOR_MOTION_ENV,
	CURSOR_MOTION_STYLES,
	cursorMotionFromEnvironment,
	parseCursorMotion,
} from "./platform/macos-ffi/cursor-motion-config.js";
export { VMComputer, type VMComputerOptions } from "./platform/vm.js";
export {
	DEFAULT_AX_MESSAGING_TIMEOUT_SECONDS,
	resolveAxMessagingTimeoutSeconds,
} from "./platform/macos-ffi/accessibility.js";
export type {
	ComputerCapabilities,
	DragOptions,
	AppStateOptions,
	KeyModifierName,
	KeyOptions,
	Point,
	PointerOptions,
	Rect,
	ScreenshotOptions,
	ScrollOptions,
	SelectTextOptions,
	Size,
} from "./types/index.js";
export type { WindowInfo, WindowInterface } from "./window/interface.js";
export { MacOSWindows } from "./window/macos.js";
export { createWindowsHostComputer, WindowsHostComputer, WindowsHostError } from "./platform/windows/index.js";
export type {
	WindowsHostComputerOptions,
	WindowsProcess,
	WindowsProcessFactory,
	WindowsTransport,
} from "./platform/windows/index.js";
export {
	createLinuxHostComputer,
	LinuxHostComputer,
	LinuxBackendError,
	LINUX_INSTALL_HINTS,
} from "./platform/linux/index.js";
export type {
	LinuxAppState,
	LinuxElementRef,
	LinuxHelperEvents,
	LinuxHelperFactory,
	LinuxHelperTransport,
	LinuxHostComputerOptions,
	LinuxScreenshotResult,
	LinuxSemanticAction,
} from "./platform/linux/index.js";
export { GuardedPlatformComputer } from "./platform/guarded-platform-computer.js";
export { denyHostInteraction, HostInteractionDenied } from "./computer/host-interaction-policy.js";
export {
	type OwnedSurface,
	closeOwnedSurface,
	isOwnedSurfacePid,
	openOwnedSurface,
	readOwnedSurfaces,
	type SurfaceAudioState,
	surfaceAudioState,
} from "./platform/owned-surfaces.js";
export { type SurfaceListening, listenToSurface } from "./platform/surface-listen.js";
