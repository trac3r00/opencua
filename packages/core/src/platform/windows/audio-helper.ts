/**
 * C# for the Windows helper's audio requests, sent once per helper process with "loadAudio" instead of
 * being embedded in the startup script: -EncodedCommand must fit the 32,767-character command line.
 */
export const windowsAudioSource = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
// WASAPI sessions of the default render endpoint, and per-process-tree loopback capture
// (Windows 10 build 20348+ / Windows 11). COM vtables are declared in their documented order.
public static class OpenCuaAudio {
 [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
 [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IMMDeviceEnumerator { int EnumAudioEndpoints(int flow,int mask,out IntPtr devices); int GetDefaultAudioEndpoint(int flow,int role,out IMMDevice device); }
 [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IMMDevice { int Activate(ref Guid iid,int context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)] out object result); }
 [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IAudioSessionManager2 { int GetAudioSessionControl(IntPtr a,int b,out IntPtr c); int GetSimpleAudioVolume(IntPtr a,int b,out IntPtr c); int GetSessionEnumerator(out IAudioSessionEnumerator sessions); }
 [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IAudioSessionEnumerator { int GetCount(out int count); int GetSession(int index,out IAudioSessionControl2 session); }
 [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IAudioSessionControl2 {
  int GetState(out int state); int GetDisplayName(out IntPtr a); int SetDisplayName(IntPtr a,IntPtr b); int GetIconPath(out IntPtr a); int SetIconPath(IntPtr a,IntPtr b);
  int GetGroupingParam(out Guid a); int SetGroupingParam(ref Guid a,IntPtr b); int RegisterAudioSessionNotification(IntPtr a); int UnregisterAudioSessionNotification(IntPtr a);
  int GetSessionIdentifier(out IntPtr a); int GetSessionInstanceIdentifier(out IntPtr a); int GetProcessId(out uint pid);
 }
 [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IAudioMeterInformation { int GetPeakValue(out float peak); }

 public static List<Dictionary<string,object>> Sessions() {
  List<Dictionary<string,object>> result=new List<Dictionary<string,object>>();
  IMMDeviceEnumerator devices=(IMMDeviceEnumerator)new MMDeviceEnumerator();
  IMMDevice device; Marshal.ThrowExceptionForHR(devices.GetDefaultAudioEndpoint(0,1,out device));
  Guid managerId=typeof(IAudioSessionManager2).GUID; object managerObject;
  Marshal.ThrowExceptionForHR(device.Activate(ref managerId,23,IntPtr.Zero,out managerObject));
  IAudioSessionEnumerator sessions; Marshal.ThrowExceptionForHR(((IAudioSessionManager2)managerObject).GetSessionEnumerator(out sessions));
  int count; Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
  string[] states={"inactive","active","expired"};
  for(int index=0;index<count;index++) {
   IAudioSessionControl2 session; if(sessions.GetSession(index,out session)!=0) continue;
   uint pid; int state; float peak=0;
   if(session.GetProcessId(out pid)!=0 || pid==0 || session.GetState(out state)!=0 || state<0 || state>2) continue;
   IAudioMeterInformation meter=session as IAudioMeterInformation;
   if(meter!=null && meter.GetPeakValue(out peak)!=0) peak=0;
   Dictionary<string,object> entry=new Dictionary<string,object>();
   entry["pid"]=(int)pid; entry["peak"]=Math.Min(1.0,Math.Max(0.0,(double)peak)); entry["state"]=states[state];
   result.Add(entry);
  }
  return result;
 }

 [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IAudioClient {
  int Initialize(int shareMode,uint flags,long bufferDuration,long periodicity,IntPtr format,IntPtr session);
  int GetBufferSize(out uint frames); int GetStreamLatency(out long latency); int GetCurrentPadding(out uint padding);
  int IsFormatSupported(int mode,IntPtr format,out IntPtr closest); int GetMixFormat(out IntPtr format); int GetDevicePeriod(out long a,out long b);
  int Start(); int Stop(); int Reset(); int SetEventHandle(IntPtr handle);
  int GetService(ref Guid iid,[MarshalAs(UnmanagedType.IUnknown)] out object service);
 }
 [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IAudioCaptureClient {
  int GetBuffer(out IntPtr data,out uint frames,out uint flags,out ulong position,out ulong counter);
  int ReleaseBuffer(uint frames); int GetNextPacketSize(out uint frames);
 }
 [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IActivateAudioInterfaceAsyncOperation { int GetActivateResult(out int result,[MarshalAs(UnmanagedType.IUnknown)] out object activated); }
 [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IActivateAudioInterfaceCompletionHandler { int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation); }
 [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IAgileObject {}
 class Completion : IActivateAudioInterfaceCompletionHandler, IAgileObject {
  public readonly ManualResetEvent Done=new ManualResetEvent(false);
  public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) { Done.Set(); return 0; }
 }
 [StructLayout(LayoutKind.Explicit)] struct BlobVariant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public uint Size; [FieldOffset(16)] public IntPtr Data; }
 [DllImport("Mmdevapi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)]
 static extern int ActivateAudioInterfaceAsync(string path,ref Guid iid,IntPtr parameters,IActivateAudioInterfaceCompletionHandler handler,out IActivateAudioInterfaceAsyncOperation operation);

 // 16-bit 44.1 kHz stereo PCM of the target process and its children, as a WAV file.
 public static byte[] Record(int pid,double seconds) {
  if(IntPtr.Size!=8) throw new PlatformNotSupportedException("process loopback needs a 64-bit helper");
  IntPtr activation=Marshal.AllocHGlobal(12), variant=IntPtr.Zero, format=Marshal.AllocHGlobal(18);
  try {
   Marshal.WriteInt32(activation,0,1); Marshal.WriteInt32(activation,4,pid); Marshal.WriteInt32(activation,8,0);
   BlobVariant blob=new BlobVariant(); blob.Type=65; blob.Size=12; blob.Data=activation;
   variant=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BlobVariant))); Marshal.StructureToPtr(blob,variant,false);
   Guid clientId=typeof(IAudioClient).GUID; Completion completion=new Completion(); IActivateAudioInterfaceAsyncOperation operation;
   Marshal.ThrowExceptionForHR(ActivateAudioInterfaceAsync("VAD\\Process_Loopback",ref clientId,variant,completion,out operation));
   if(!completion.Done.WaitOne(5000)) throw new TimeoutException("process loopback activation timed out");
   int activated; object clientObject; Marshal.ThrowExceptionForHR(operation.GetActivateResult(out activated,out clientObject));
   Marshal.ThrowExceptionForHR(activated);
   IAudioClient client=(IAudioClient)clientObject;
   short channels=2, bits=16; int rate=44100, align=channels*bits/8;
   Marshal.WriteInt16(format,0,1); Marshal.WriteInt16(format,2,channels); Marshal.WriteInt32(format,4,rate);
   Marshal.WriteInt32(format,8,rate*align); Marshal.WriteInt16(format,12,(short)align); Marshal.WriteInt16(format,14,bits); Marshal.WriteInt16(format,16,0);
   Marshal.ThrowExceptionForHR(client.Initialize(0,0x80000000u|0x08000000u,2000000,0,format,IntPtr.Zero));
   Guid captureId=typeof(IAudioCaptureClient).GUID; object captureObject;
   Marshal.ThrowExceptionForHR(client.GetService(ref captureId,out captureObject));
   IAudioCaptureClient capture=(IAudioCaptureClient)captureObject;
   MemoryStream pcm=new MemoryStream();
   Marshal.ThrowExceptionForHR(client.Start());
   DateTime end=DateTime.UtcNow.AddSeconds(seconds);
   try {
    while(DateTime.UtcNow<end) {
     uint packet; Marshal.ThrowExceptionForHR(capture.GetNextPacketSize(out packet));
     if(packet==0) { Thread.Sleep(10); continue; }
     IntPtr data; uint frames, flags; ulong position, counter;
     Marshal.ThrowExceptionForHR(capture.GetBuffer(out data,out frames,out flags,out position,out counter));
     byte[] chunk=new byte[frames*align];
     if((flags&2)==0) Marshal.Copy(data,chunk,0,chunk.Length);
     pcm.Write(chunk,0,chunk.Length);
     Marshal.ThrowExceptionForHR(capture.ReleaseBuffer(frames));
    }
   } finally { client.Stop(); }
   return Wav(pcm.ToArray(),channels,rate,bits);
  } finally {
   Marshal.FreeHGlobal(activation); Marshal.FreeHGlobal(format); if(variant!=IntPtr.Zero) Marshal.FreeHGlobal(variant);
  }
 }

 static byte[] Wav(byte[] pcm,short channels,int rate,short bits) {
  MemoryStream file=new MemoryStream(); BinaryWriter writer=new BinaryWriter(file);
  writer.Write(new char[]{'R','I','F','F'}); writer.Write(36+pcm.Length); writer.Write(new char[]{'W','A','V','E','f','m','t',' '});
  writer.Write(16); writer.Write((short)1); writer.Write(channels); writer.Write(rate); writer.Write(rate*channels*bits/8);
  writer.Write((short)(channels*bits/8)); writer.Write(bits); writer.Write(new char[]{'d','a','t','a'}); writer.Write(pcm.Length); writer.Write(pcm);
  writer.Flush(); return file.ToArray();
 }
}
`;
