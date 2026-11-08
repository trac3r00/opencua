import "../env-compat.js";
// This entrypoint must remain free of native host UI, permission and input imports.
export {
	type CursorOwner,
	currentCursorIdentity,
	currentCursorOwner,
	withCursorIdentity,
} from "../computer/cursor-scope.js";
export { InputInterrupted, runInInputScope } from "../computer/input-scope.js";
export type { ScreenshotResult } from "../computer/interface.js";
export {
	type GuestAccessibility,
	type GuestAccessibilityElement,
	readGuestAccessibility,
} from "./guest-accessibility.js";
export { StopSwitch, type StopStatusSource, describeUserStop } from "./stop-switch.js";
export { TartGuestSupervisor, type GuestSupervisorDependencies } from "./tart-guest-supervisor.js";
export { TartGuestTransport, type GuestCommandRunner } from "./tart-guest-transport.js";
