export type HostInteraction =
	| "physical-pointer"
	| "global-input"
	| "host-focus"
	| "host-clipboard"
	| "host-spaces"
	| "host-window"
	| "host-overlay";

export class HostInteractionDenied extends Error {
	readonly code = "HOST_INTERACTION_FORBIDDEN";

	constructor(readonly operation: HostInteraction) {
		super(
			`${operation} cannot operate on the human desktop: opencua drives host apps only in the background, per process, and never takes focus, posts global HID input or moves the physical pointer; use background delivery, or an agent-owned isolated session where host input is unavailable.`,
		);
		this.name = "HostInteractionDenied";
	}
}

export function denyHostInteraction(operation: HostInteraction): never {
	throw new HostInteractionDenied(operation);
}

let attendedHostDelivery = false;

/**
 * Attended (direct) delivery is the person's opt-in, made once per process (OPENCUA_DELIVERY=attended) when the host
 * computer is built with it. Only then may input use the global HID tap, move the real pointer, or activate and raise
 * an app. Background delivery never sets it, so those primitives stay refused there.
 */
export function setAttendedHostDelivery(enabled: boolean): void {
	attendedHostDelivery = enabled;
}

/** Refuses `operation` unless this process opted into attended delivery. */
export function requireAttendedHostDelivery(operation: HostInteraction): void {
	if (!attendedHostDelivery) denyHostInteraction(operation);
}
