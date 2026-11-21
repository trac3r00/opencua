/** Desktop tools that only the full toolset registers: element actions, batching, and OS helpers. */
import { BROWSER_TOOL_NAMES } from "@opencua/browser";

export const FULL_ONLY_TOOL_NAMES = [
	"click",
	"click_target",
	"perform_secondary_action",
	"set_value",
	"set_fields",
	"run_steps",
	"run_hands",
	"observe_apps",
	"run_parallel",
	"manage_workers",
	"run_worker",
	"select_text",
	"drag",
	"scroll",
	"type_text",
	"press_keys",
	"invoke_menu",
	"set_window_frame",
	"clipboard_read",
	"clipboard_write",
	"clipboard_clear",
	"run_decision",
	"surface",
	"run_applescript",
] as const;

/** The small observe / script / verify surface registered by `OPENCUA_TOOLSET=lean`. */
export const LEAN_TOOL_NAMES = [
	"list_apps",
	"open_app",
	"list_windows",
	"list_displays",
	"get_app_state",
	"find_elements",
	"run_script",
	"get_capabilities",
	"get_tool_usage",
	"verify_state",
	"ask_user",
	"analyze_screen",
] as const;

/** Opt-in iPhone Mirroring tools, registered only with `OPENCUA_IPHONE=1`. */
export const IPHONE_TOOL_NAMES = [
	"ios_observe",
	"ios_find_text",
	"ios_run",
	"ios_screenshot",
	"ios_tap",
	"ios_tap_text",
	"ios_long_press",
	"ios_swipe",
	"ios_scroll",
	"ios_type_text",
	"ios_press_keys",
	"ios_home",
	"ios_app_switcher",
	"ios_open_app",
] as const;

export const UTM_TOOL_NAMES = ["utm_list", "utm_observe", "utm_run"] as const;

/** Opt-in cua-history tools, registered only with `OPENCUA_HISTORY=1`. */
export const HISTORY_TOOL_NAMES = [
	"cua_history_status",
	"cua_history_get_settings",
	"cua_history_update_settings",
	"cua_history_pause",
	"cua_history_resume",
	"cua_history_suggest_skills",
	"cua_history_save_skill",
] as const;

/** Every tool this server can ever register, including opt-in tools. */
export const TOOL_NAMES = [
	...LEAN_TOOL_NAMES,
	...FULL_ONLY_TOOL_NAMES,
	...IPHONE_TOOL_NAMES,
	...BROWSER_TOOL_NAMES,
	...UTM_TOOL_NAMES,
	...HISTORY_TOOL_NAMES,
] as const;

/** Tools registered for one configuration: lean or full desktop, plus iPhone and browser when enabled. */
export function toolNamesFor(
	toolset: "full" | "lean",
	iphone: boolean,
	browser = false,
	utm = false,
	history = false,
): readonly string[] {
	return [
		...LEAN_TOOL_NAMES,
		...(toolset === "full" ? FULL_ONLY_TOOL_NAMES : []),
		...(iphone ? IPHONE_TOOL_NAMES : []),
		...(browser ? BROWSER_TOOL_NAMES : []),
		...(utm ? UTM_TOOL_NAMES : []),
		...(history ? HISTORY_TOOL_NAMES : []),
	];
}
