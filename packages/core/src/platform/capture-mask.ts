/**
 * Password managers and system authentication prompts. Their windows are masked in every capture: a display
 * capture leaves them out, and a capture of one of their windows returns no image. They are never blocked: input,
 * accessibility and control work as for any other app, and observations mark them `masked` so the agent knows
 * something is there. Mirrored by kSckMaskedBundleIds and kSckMaskedOwnerNames in native/sckit.m; the two lists must
 * stay equal (capture-mask.test.ts checks it).
 */
export const MASKED_CAPTURE_BUNDLE_IDS: readonly string[] = [
	"com.1password.1password",
	"com.agilebits.onepassword7",
	"com.bitwarden.desktop",
	"com.apple.keychainaccess",
	"com.apple.Passwords",
	"com.lastpass.LastPass",
	"com.dashlane.dashlanephonefinal",
	"com.apple.SecurityAgent",
];

/** Authentication prompt processes, matched by process or owner name: they may have no bundle id. */
export const MASKED_CAPTURE_OWNER_NAMES: readonly string[] = ["SecurityAgent", "coreautha"];

const maskedBundleIds = new Set(MASKED_CAPTURE_BUNDLE_IDS.map((bundleId) => bundleId.toLowerCase()));

/** Whether captures mask the windows of this owner. Bundle ids compare without case, owner names exactly. */
export function isMaskedCaptureOwner(owner: {
	readonly bundleId?: string | undefined;
	readonly name?: string | undefined;
}): boolean {
	return (
		(owner.bundleId !== undefined && maskedBundleIds.has(owner.bundleId.toLowerCase())) ||
		(owner.name !== undefined && MASKED_CAPTURE_OWNER_NAMES.includes(owner.name))
	);
}

/** The windows among `windows` whose captures are masked, looking each owner's bundle id up once. */
export function maskedCaptureWindows<TWindow extends { readonly ownerPid: number; readonly ownerName: string }>(
	windows: readonly TWindow[],
	bundleIdOf: (pid: number) => string | undefined,
): readonly TWindow[] {
	const bundleIds = new Map<number, string | undefined>();
	return windows.filter((window) => {
		if (!bundleIds.has(window.ownerPid)) {
			bundleIds.set(window.ownerPid, bundleIdOf(window.ownerPid));
		}
		return isMaskedCaptureOwner({ bundleId: bundleIds.get(window.ownerPid), name: window.ownerName });
	});
}

/** A capture that returned no image on purpose: the window belongs to a masked app (see MASKED_CAPTURE_BUNDLE_IDS). */
export class CaptureMaskedError extends Error {
	readonly code = "CAPTURE_MASKED";

	constructor(readonly windowId: number) {
		super(
			`window ${windowId} belongs to a password manager or an authentication prompt, so its capture is masked: no image is returned. The app is not blocked; read it through its accessibility elements instead.`,
		);
		this.name = "CaptureMaskedError";
	}
}
