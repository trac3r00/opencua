/** How far a failed call got before it failed: nothing reached the app, input reached it, or it is not known. */
export type FailureDelivery = "not_sent" | "sent" | "unknown";

/** Whether the same call may be repeated: safe (nothing changed), unsafe (verify first), or never (ask the user). */
export type FailureRetry = "safe" | "unsafe" | "never";

/** The machine-readable facts a failure carries from where it was thrown to the tool error envelope. */
export interface ToolFailureFields {
	readonly code: string;
	readonly delivery: FailureDelivery;
	readonly retry: FailureRetry;
	readonly hint: string;
	/** Facts that justify the code (ids, points, the element found instead), when there are any. */
	readonly evidence?: Readonly<Record<string, unknown>>;
}

/**
 * A failure whose meaning is decided where it is thrown, so the error envelope reads its code, delivery and retry
 * from fields instead of guessing them from the message text.
 */
export class ToolFailure extends Error {
	readonly code: string;
	readonly delivery: FailureDelivery;
	readonly retry: FailureRetry;
	readonly hint: string;
	readonly evidence: Readonly<Record<string, unknown>> | undefined;

	constructor(message: string, fields: ToolFailureFields) {
		super(message);
		this.name = "ToolFailure";
		this.code = fields.code;
		this.delivery = fields.delivery;
		this.retry = fields.retry;
		this.hint = fields.hint;
		this.evidence = fields.evidence;
	}
}

/** App resolution failed before any read or input: the app is closed (or not an app), not unusable. */
export function appNotRunning(message: string): ToolFailure {
	return new ToolFailure(message, {
		code: "APP_NOT_RUNNING",
		delivery: "not_sent",
		retry: "safe",
		hint: "Nothing was sent: no running app matched. Check list_apps, or open it with open_app (an installed app by name or bundle id), then observe it again.",
	});
}
