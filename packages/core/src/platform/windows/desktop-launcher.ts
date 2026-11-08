/**
 * Runs the helper on its own Win32 desktop (CreateDesktop), never the person's: apps it starts
 * there inherit that desktop, so their windows, focus and input never reach the person's screen.
 * The helper bootstrap (UTF-16LE base64) arrives in the OPENCUA_HELPER environment variable, not on
 * stdin: a launcher that read stdin could buffer RPC lines meant for the helper. The launcher creates
 * the desktop and starts PowerShell on it with its own stdin/stdout/stderr, so the JSONL channel
 * continues straight to the helper.
 */
export const DESKTOP_NAME = /^OpenCUA-[A-Za-z0-9-]{1,48}$/;

export function desktopLauncherScript(desktop: string, executable: string): string {
	if (!DESKTOP_NAME.test(desktop)) throw new RangeError("desktop must look like OpenCUA-<letters, digits, dashes>");
	if (executable !== "pwsh" && executable !== "powershell.exe") throw new RangeError("unknown PowerShell executable");
	return String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenCuaDesktop {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO {
  public int cb; public string Reserved; public string Desktop; public string Title;
  public int X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public short Show,Reserved2; public IntPtr Reserved3,In,Out,Err;
 }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr Process,Thread; public int Pid,Tid; }
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktop(string name,IntPtr d,IntPtr m,int f,uint access,IntPtr sa);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,string cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string dir,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 public static int Run(string desktop,string command) {
  if(CreateDesktop(desktop,IntPtr.Zero,IntPtr.Zero,0,0x10000000,IntPtr.Zero)==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
  STARTUPINFO si=new STARTUPINFO(); si.cb=Marshal.SizeOf(typeof(STARTUPINFO)); si.Desktop=desktop; si.Flags=0x100;
  si.In=GetStdHandle(-10); si.Out=GetStdHandle(-11); si.Err=GetStdHandle(-12);
  PROCESS_INFORMATION pi;
  if(!CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,0x08000000,IntPtr.Zero,null,ref si,out pi)) throw new System.ComponentModel.Win32Exception();
  WaitForSingleObject(pi.Process,0xFFFFFFFF); uint code; GetExitCodeProcess(pi.Process,out code); return (int)code;
 }
}
'@
$env:OPENCUA_DESKTOP='${desktop}'
exit [OpenCuaDesktop]::Run('${desktop}','${executable} -NoLogo -NoProfile -NonInteractive -Command "Invoke-Expression ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:OPENCUA_HELPER)))"')
`;
}
