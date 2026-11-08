import { describe, expect, it } from "bun:test";
import { DESKTOP_NAME, desktopLauncherScript } from "./desktop-launcher.js";
import { PowerShellTransport, type WindowsProcessFactory } from "./transport.js";

interface Launch {
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>> | undefined;
}

function recordingFactory(launches: Launch[]): WindowsProcessFactory {
	return (_executable, args, onLine, _onExit, env) => {
		launches.push({ args, env });
		return {
			write(line) {
				const id: unknown = JSON.parse(line).id;
				onLine(JSON.stringify({ id, result: true }));
			},
			kill() {},
		};
	};
}

const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf16le");

describe("#given an owned desktop name #when the Windows helper starts #then it runs through the desktop launcher", () => {
	it("encodes the launcher on the command line and hands the helper over in OPENCUA_HELPER", async () => {
		const launches: Launch[] = [];
		const transport = new PowerShellTransport({
			desktop: "OpenCUA-agent-1",
			processFactory: recordingFactory(launches),
		});
		expect(await transport.request("screen")).toBe(true);
		const [launch] = launches;
		const command = launch?.args.at(-1) ?? "";
		expect(decode(command)).toContain("[OpenCuaDesktop]::Run('OpenCUA-agent-1'");
		expect(command.length).toBeLessThan(30_000);
		expect(decode(launch?.env?.["OPENCUA_HELPER"] ?? "")).toContain("GZipStream");
		await transport.close();
	});

	it("starts on the person's desktop with no launcher and no helper variable when no desktop is named", async () => {
		const launches: Launch[] = [];
		const transport = new PowerShellTransport({ processFactory: recordingFactory(launches) });
		await transport.request("screen");
		expect(launches[0]?.env).toBeUndefined();
		expect(decode(launches[0]?.args.at(-1) ?? "")).not.toContain("OpenCuaDesktop");
		await transport.close();
	});

	it("refuses names that could escape the launcher's quoting or name a system desktop", () => {
		for (const desktop of [
			"Default",
			"Winlogon",
			"OpenCUA-a'b",
			"OpenCUA-a b",
			"OpenCUA-",
			`OpenCUA-${"x".repeat(49)}`,
			"opencua-x",
		]) {
			expect(DESKTOP_NAME.test(desktop)).toBe(false);
			expect(() => new PowerShellTransport({ desktop })).toThrow("desktop must look like");
			expect(() => desktopLauncherScript(desktop, "pwsh")).toThrow(RangeError);
		}
		expect(() => desktopLauncherScript("OpenCUA-ok", "cmd.exe")).toThrow(RangeError);
	});
});
