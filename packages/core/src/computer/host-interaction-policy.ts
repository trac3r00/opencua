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

/** No delivery flag or caller-provided identity can authorize the human's focus, HID stream or pointer. */
export function denyHostInteraction(operation: HostInteraction): never {
	throw new HostInteractionDenied(operation);
}
