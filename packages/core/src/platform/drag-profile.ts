export type DragProfile = "smoothstep" | "lognormal";

const DRAG_PROFILE_ENV = "OPENCUA_DRAG_PROFILE";

/*
 * Sigma-lognormal single stroke (Plamondon). The CDF is evaluated over ln(x) with x = WINDOW_START + t * WINDOW_SPAN.
 * The velocity peak sits at x* = exp(MU - SIGMA^2) ~ 0.3255, which maps to t ~ 0.213: a ballistic
 * acceleration phase followed by a long corrective tail. The window covers +-3 sigma so both CDF ends are reached.
 */
const LOGNORMAL_MU = -1.0;
const LOGNORMAL_SIGMA = 0.35;
const WINDOW_START = Math.exp(LOGNORMAL_MU - 3 * LOGNORMAL_SIGMA);
const WINDOW_END = Math.exp(LOGNORMAL_MU + 3 * LOGNORMAL_SIGMA);
const WINDOW_SPAN = WINDOW_END - WINDOW_START;

/** Standard normal CDF via Abramowitz-Stegun 7.1.26 erf (max absolute error 1.5e-7). */
function normalCdf(z: number): number {
	const x = Math.abs(z) / Math.SQRT2;
	const t = 1 / (1 + 0.3275911 * x);
	const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
	const erf = 1 - poly * Math.exp(-x * x);
	return 0.5 * (1 + Math.sign(z) * erf);
}

function lognormalCdfAt(t: number): number {
	return normalCdf((Math.log(WINDOW_START + t * WINDOW_SPAN) - LOGNORMAL_MU) / LOGNORMAL_SIGMA);
}

const CDF_START = lognormalCdfAt(0);
const CDF_RANGE = lognormalCdfAt(1) - CDF_START;

export function smoothstepProgress(t: number): number {
	const clamped = Math.min(1, Math.max(0, t));
	return clamped * clamped * (3 - 2 * clamped);
}

export function lognormalProgress(t: number): number {
	const clamped = Math.min(1, Math.max(0, t));
	return (lognormalCdfAt(clamped) - CDF_START) / CDF_RANGE;
}

export function dragProfile(env: Readonly<Record<string, string | undefined>> = process.env): DragProfile {
	return env[DRAG_PROFILE_ENV]?.trim().toLowerCase() === "lognormal" ? "lognormal" : "smoothstep";
}
