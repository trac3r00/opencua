/** Embedded so compiled consumers do not need an unbundled .ps1 asset. Stdout is JSONL only. */
export const windowsHelperScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class OpenCuaNative {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 delegate bool EnumCallback(IntPtr window,IntPtr parameter);
 [DllImport("user32.dll",SetLastError=true)] static extern bool EnumWindows(EnumCallback callback,IntPtr parameter);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder title,int count);
 public static IntPtr[] Windows(int pid) {
  List<IntPtr> windows=new List<IntPtr>();
  if(!EnumWindows(delegate(IntPtr window,IntPtr parameter) {
   uint owner; GetWindowThreadProcessId(window,out owner);
   RECT bounds;
   if((pid==0 || owner==(uint)pid) && GetWindowRect(window,out bounds) &&
    bounds.Right>bounds.Left && bounds.Bottom>bounds.Top) windows.Add(window);
   return true;
  },IntPtr.Zero)) throw new Win32Exception();
  return windows.ToArray();
 }
 public static string Title(IntPtr window) {
  StringBuilder title=new StringBuilder(4096); GetWindowText(window,title,title.Capacity); return title.ToString();
 }
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr h,POINT p,uint f);
 [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h,ref POINT p);
 public static IntPtr Target(IntPtr h,int x,int y) {
  for(int i=0;i<32;i++) { POINT p; p.X=x; p.Y=y; ScreenToClient(h,ref p);
   IntPtr c=ChildWindowFromPointEx(h,p,5); if(c==IntPtr.Zero||c==h) return h; h=c; }
  return h;
 }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSE {
  public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra;
 }
 [StructLayout(LayoutKind.Sequential)] public struct KEY {
  public ushort Vk,Scan; public uint Flags,Time; public UIntPtr Extra;
 }
 [StructLayout(LayoutKind.Explicit)] public struct UNION {
  [FieldOffset(0)] public MOUSE Mouse; [FieldOffset(0)] public KEY Key;
 }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint Type; public UNION Value; }
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint n,INPUT[] input,int size);
 static void Send(INPUT i) {
  if(SendInput(1,new INPUT[]{i},Marshal.SizeOf(typeof(INPUT)))!=1)
   throw new InvalidOperationException("SendInput failed (possibly UIPI)");
 }
 public static void Mouse(int x,int y,uint flags,uint data) {
  INPUT i=new INPUT(); i.Value.Mouse.X=x; i.Value.Mouse.Y=y;
  i.Value.Mouse.Flags=flags; i.Value.Mouse.Data=data; Send(i);
 }
 public static void Keyboard(ushort vk,bool up) {
  INPUT i=new INPUT(); i.Type=1; i.Value.Key.Vk=vk; i.Value.Key.Flags=up?2u:0u; Send(i);
 }
}
'@
[void][OpenCuaNative]::SetProcessDPIAware()
$script:Snapshots=@{}
$script:NextElement=0
$script:Session=[guid]::NewGuid().ToString('N')
function Fail($code,$message) { throw "$code|$message" }
function Bounds($e) {
 $r=$e.Current.BoundingRectangle
 if ($r.IsEmpty) { return @{x=0;y=0;width=0;height=0} }
 return @{x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}
}
function HandleBounds($handle) {
 $r=New-Object OpenCuaNative+RECT
 if (-not [OpenCuaNative]::GetWindowRect($handle,[ref]$r)) {
  Fail 'NO_WINDOW' 'Window bounds unavailable'
 }
 return @{x=$r.Left;y=$r.Top;width=($r.Right-$r.Left);height=($r.Bottom-$r.Top)}
}
function WindowBounds($w) { return HandleBounds ([IntPtr]$w.Current.NativeWindowHandle) }
function Handles($processId) {
 $owner=0
 if ($null -ne $processId) { $owner=[int]$processId }
 return [OpenCuaNative]::Windows($owner)
}
function Windows($processId) {
 foreach ($handle in (Handles $processId)) {
  try { [System.Windows.Automation.AutomationElement]::FromHandle($handle) }
  catch [System.Windows.Automation.ElementNotAvailableException] { continue }
 }
}
function Window($p) {
 $handle=Handles $p.pid | Where-Object { $null -eq $p.windowId -or $_.ToInt64() -eq $p.windowId } | Select-Object -First 1
 if ($null -eq $handle) { Fail 'NO_WINDOW' 'No target window; supply a running app pid/windowId' }
 return [System.Windows.Automation.AutomationElement]::FromHandle($handle)
}
function Inventory($processId) {
 foreach ($handle in (Handles $processId)) {
  @{id=$handle.ToInt64();title=[OpenCuaNative]::Title($handle);bounds=(HandleBounds $handle)}
 }
}
function Pattern($e,$name) {
 $t=[type]("System.Windows.Automation."+ $name +"Pattern")
 $field=$t.GetField('Pattern')
 $value=$null
 if ($e.TryGetCurrentPattern($field.GetValue($null),[ref]$value)) { return $value }
 return $null
}
function Resolve($p) {
 $s=$script:Snapshots[[string]$p.pid]
 if ($null -eq $s -or $s.key -ne $p.snapshot) { Fail 'STALE_REF' 'Snapshot expired; observe again' }
 $r=$s.refs[[string]$p.ref]
 if ($null -eq $r) { Fail 'STALE_REF' 'Unknown element; observe again' }
 try {
  if (($r.element.GetRuntimeId() -join ',') -ne $r.runtime -or $r.element.Current.ProcessId -ne $p.pid) {
   Fail 'STALE_REF' 'RuntimeId changed; observe again'
  }
 } catch { Fail 'STALE_REF' 'Element no longer resolves to its observed RuntimeId' }
 return $r.element
}
function Capture($w,$p) {
 $h=[IntPtr]$w.Current.NativeWindowHandle
 $r=New-Object OpenCuaNative+RECT
 if (-not [OpenCuaNative]::GetWindowRect($h,[ref]$r)) { Fail 'CAPTURE_FAILED' 'GetWindowRect failed' }
 $width=$r.Right-$r.Left; $height=$r.Bottom-$r.Top
 if ($width -le 0 -or $height -le 0) { Fail 'CAPTURE_FAILED' 'Window has empty bounds' }
 $bitmap=[Drawing.Bitmap]::new($width,$height)
 $graphics=[Drawing.Graphics]::FromImage($bitmap)
 try {
  $dc=$graphics.GetHdc()
  try {
   if (-not [OpenCuaNative]::PrintWindow($h,$dc,2)) { Fail 'CAPTURE_FAILED' 'PrintWindow(PW_RENDERFULLCONTENT) failed' }
  } finally { $graphics.ReleaseHdc($dc) }
  $image=$bitmap
  $scaled=$null
  if ($null -ne $p.targetSize) {
   $scaled=[Drawing.Bitmap]::new($bitmap,[Drawing.Size]::new($p.targetSize.width,$p.targetSize.height))
   $image=$scaled
  }
  $stream=[IO.MemoryStream]::new()
  try {
   $format=[Drawing.Imaging.ImageFormat]::Png; $mime='image/png'
   if ($p.format -eq 'jpeg') { $format=[Drawing.Imaging.ImageFormat]::Jpeg; $mime='image/jpeg' }
   $image.Save($stream,$format)
   return @{data=[Convert]::ToBase64String($stream.ToArray());width=$image.Width;height=$image.Height;mimeType=$mime}
  } finally { $stream.Dispose(); if ($null -ne $scaled) { $scaled.Dispose() } }
 } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
function Walk($e,$refs,$elements,$limit,$depth) {
 if ($elements.Count -ge $limit -or $depth -gt 64) { $script:Truncated=$true; return $null }
 $id=$script:NextElement; $script:NextElement++
 $actions=[Collections.Generic.List[string]]::new()
 foreach ($pair in @(@('Invoke','press'),@('Toggle','toggle'),@('Value','setValue'),
  @('SelectionItem','select'),@('ExpandCollapse','expand'),@('Scroll','scroll'),@('Text','selectText'))) {
  if ($null -ne (Pattern $e $pair[0])) { $actions.Add($pair[1]) }
 }
 $value=$null; $vp=Pattern $e 'Value'
 if ($null -ne $vp -and -not $e.Current.IsPassword) { $value=$vp.Current.Value }
 $children=[Collections.Generic.List[int]]::new()
 $item=@{id=$id;role=$e.Current.ControlType.ProgrammaticName.Replace('ControlType.','AX');
  label=$e.Current.Name;value=$value;frame=(Bounds $e);actions=@($actions.ToArray());children=@()}
 $elements.Add($item)
 $refs[[string]$id]=@{element=$e;runtime=($e.GetRuntimeId() -join ',')}
 $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
 $child=$walker.GetFirstChild($e)
 while ($null -ne $child) {
  if ($elements.Count -ge $limit) { $script:Truncated=$true; break }
  $childId=Walk $child $refs $elements $limit ($depth+1)
  if ($null -ne $childId) { $children.Add($childId) }
  $child=$walker.GetNextSibling($child)
 }
 $item.children=@($children.ToArray())
 return $id
}
function Snapshot($p) {
 $w=Window $p; $processId=$w.Current.ProcessId
 $bounds=WindowBounds $w
 $elements=[Collections.Generic.List[object]]::new(); $refs=@{}
 $key=$script:Session+':'+[guid]::NewGuid().ToString('N')
 $script:Truncated=$false
 if ($p.options.includeAccessibilityTree -ne $false) {
  $root=$w
  if ($null -ne $p.options.subtreeOf) {
   $root=Resolve @{pid=$processId;snapshot=$p.previous;ref=$p.options.subtreeOf}
  }
  $limit=2000
  if ($null -ne $p.options.maxElements) { $limit=[int]$p.options.maxElements }
  [void](Walk $root $refs $elements $limit 0)
  if ($p.options.probe -ne $true) { $script:Snapshots[[string]$processId]=@{key=$key;refs=$refs} }
 } elseif ($p.options.probe -ne $true) { $script:Snapshots.Remove([string]$processId) }
 $image=@{data='';width=$bounds.width;height=$bounds.height;mimeType='image/png'}
 if ($p.options.includeScreenshot -ne $false) { $image=Capture $w @{targetSize=$p.options.screenshotSize} }
 $process=Get-Process -Id $processId
 return @{
  app=$process.ProcessName;bundleId=$process.ProcessName;pid=$processId;
  frontmost=([OpenCuaNative]::GetForegroundWindow() -eq [IntPtr]$w.Current.NativeWindowHandle);
  axAvailable=$true;elements=@($elements.ToArray());observationKey=$key;
  screenshotBase64=$image.data;screenshotWidth=$image.width;screenshotHeight=$image.height;screenshotMimeType=$image.mimeType;
  display=@{width=[OpenCuaNative]::GetSystemMetrics(0);height=[OpenCuaNative]::GetSystemMetrics(1);scaleFactor=1};
  windowBounds=$bounds;windowId=$w.Current.NativeWindowHandle;windowTitle=$w.Current.Name;
  elementsTruncated=$script:Truncated;treeSkipped=($p.options.includeAccessibilityTree -eq $false);
  windowCandidates=@(Inventory $processId)
 }
}
function WriteText($e,$text,$append) {
 if ($e.Current.IsPassword) { Fail 'UNSUPPORTED' 'Password controls are not writable through this backend' }
 $pattern=Pattern $e 'Value'
 if ($null -ne $pattern -and -not $pattern.Current.IsReadOnly) {
  if ($append) { $text=$pattern.Current.Value+$text }
  $pattern.SetValue($text); return
 }
 if ($WmCharAllowed -and $append -and $e.Current.NativeWindowHandle -ne 0) {
  foreach ($c in $text.ToCharArray()) {
   if (-not [OpenCuaNative]::PostMessage([IntPtr]$e.Current.NativeWindowHandle,0x102,[IntPtr][int]$c,[IntPtr]::Zero)) {
    Fail 'INPUT_FAILED' 'WM_CHAR posting failed'
   }
  }
  return
 }
 Fail 'UNSUPPORTED' 'Writable ValuePattern unavailable (WM_CHAR requires explicit allowWmChar)'
}
function Action($p) {
 $e=Resolve $p
 switch ($p.action) {
  'press' {
   foreach ($name in @('Invoke','Toggle','SelectionItem','ExpandCollapse')) {
    $pattern=Pattern $e $name
    if ($null -ne $pattern) {
     switch ($name) {
      'Invoke' { $pattern.Invoke() }
      'Toggle' { $pattern.Toggle() }
      'SelectionItem' { $pattern.Select() }
      'ExpandCollapse' { $pattern.Expand() }
     }
     return
    }
   }
   Fail 'UNSUPPORTED' 'Element has no semantic press pattern'
  }
  'setValue' { WriteText $e $p.value $false; return }
  'toggle' { $pattern=Pattern $e 'Toggle'; if ($null -ne $pattern) { $pattern.Toggle(); return } }
  'select' { $pattern=Pattern $e 'SelectionItem'; if ($null -ne $pattern) { $pattern.Select(); return } }
  'expand' { $pattern=Pattern $e 'ExpandCollapse'; if ($null -ne $pattern) { $pattern.Expand(); return } }
  'collapse' { $pattern=Pattern $e 'ExpandCollapse'; if ($null -ne $pattern) { $pattern.Collapse(); return } }
  'scroll' {
   $pattern=Pattern $e 'Scroll'
   if ($null -ne $pattern) {
    $amount=[System.Windows.Automation.ScrollAmount]::SmallIncrement
    if ($p.direction -in @('up','left')) { $amount=[System.Windows.Automation.ScrollAmount]::SmallDecrement }
    $none=[System.Windows.Automation.ScrollAmount]::NoAmount
    for ($i=0;$i -lt $p.amount;$i++) {
     if ($p.direction -in @('left','right')) { $pattern.Scroll($amount,$none) } else { $pattern.Scroll($none,$amount) }
    }
    return
   }
  }
  'selectText' {
   $pattern=Pattern $e 'Text'
   if ($null -ne $pattern) {
    $range=$pattern.DocumentRange
    if ($null -ne $p.text) { $range=$range.FindText($p.text,$false,$false) }
    if ($null -eq $range) { Fail 'TEXT_NOT_FOUND' 'Requested text is not present' }
    if ($p.selection -eq 'before') {
     $range.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
      $range,[System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
    } elseif ($p.selection -eq 'after') {
     $range.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
      $range,[System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
    }
    $range.Select(); return
   }
  }
 }
 Fail 'UNSUPPORTED' ('Unsupported UIA action: '+$p.action)
}
function Physical($p) {
 if (-not $PhysicalAllowed) { Fail 'PHYSICAL_INPUT_REQUIRED' 'Physical input is disabled' }
 if ($p.kind -eq 'key') {
  $names=@{enter=13;tab=9;escape=27;esc=27;backspace=8;delete=46;space=32;left=37;up=38;right=39;down=40;home=36;end=35;pageup=33;pagedown=34}
  $key=$p.key.ToLowerInvariant()
  $vk=$names[$key]
  if ($null -eq $vk -and $key.Length -eq 1) { $vk=[int][char]$key.ToUpperInvariant() }
  if ($null -eq $vk) { Fail 'UNSUPPORTED' 'Unknown physical key' }
  $mods=[Collections.Generic.List[int]]::new()
  foreach ($m in $p.modifiers) {
   switch ($m) { {$_ -in @('ctrl','control')} {$mods.Add(17)}
    'shift' {$mods.Add(16)} {$_ -in @('alt','opt','option')} {$mods.Add(18)}
    {$_ -in @('cmd','command')} {$mods.Add(91)} }
  }
  try {
   foreach ($m in $mods) { [OpenCuaNative]::Keyboard($m,$false) }
   [OpenCuaNative]::Keyboard($vk,$false)
  } finally {
   [OpenCuaNative]::Keyboard($vk,$true)
   $mods.Reverse(); foreach ($m in $mods) { [OpenCuaNative]::Keyboard($m,$true) }
  }
  return
 }
 $x=[int](($p.x-[OpenCuaNative]::GetSystemMetrics(76))*65535/[Math]::Max(1,([OpenCuaNative]::GetSystemMetrics(78)-1)))
 $y=[int](($p.y-[OpenCuaNative]::GetSystemMetrics(77))*65535/[Math]::Max(1,([OpenCuaNative]::GetSystemMetrics(79)-1)))
 [OpenCuaNative]::Mouse($x,$y,0xC001,0)
 if ($p.kind -eq 'move') { return }
 $down=2; $up=4
 if ($p.button -eq 'right') { $down=8;$up=16 }
 if ($p.button -eq 'middle') { $down=32;$up=64 }
 [OpenCuaNative]::Mouse(0,0,$down,0)
 try {
  if ($p.kind -eq 'drag') {
   $x=[int](($p.to.x-[OpenCuaNative]::GetSystemMetrics(76))*65535/[Math]::Max(1,([OpenCuaNative]::GetSystemMetrics(78)-1)))
   $y=[int](($p.to.y-[OpenCuaNative]::GetSystemMetrics(77))*65535/[Math]::Max(1,([OpenCuaNative]::GetSystemMetrics(79)-1)))
   [OpenCuaNative]::Mouse($x,$y,0xC001,0)
  }
 } finally { [OpenCuaNative]::Mouse(0,0,$up,0) }
 if ($p.kind -eq 'doubleClick') {
  [OpenCuaNative]::Mouse(0,0,$down,0); [OpenCuaNative]::Mouse(0,0,$up,0)
 }
}
function Dispatch($method,$p) {
 switch ($method) {
  'snapshot' { return Snapshot $p }
  'listWindows' { return ,@(Inventory $p.pid) }
  'listApps' {
   $seen=@{}
   return ,@(Windows $null | ForEach-Object {
    $processId=$_.Current.ProcessId
    if (-not $seen.ContainsKey($processId)) {
     $seen[$processId]=$true; $process=Get-Process -Id $processId
     @{name=$process.ProcessName;bundleId=$process.ProcessName;pid=$processId;isRunning=$true;
      isFrontmost=([OpenCuaNative]::GetForegroundWindow() -eq [IntPtr]$_.Current.NativeWindowHandle)}
    }
   })
  }
  'screenshot' { return Capture (Window $p) $p }
  'action' { Action $p; return $null }
  'type' {
   $e=[System.Windows.Automation.AutomationElement]::FocusedElement
   if ($null -eq $e -or $e.Current.ProcessId -ne $p.pid) { Fail 'NO_FOCUSED_ELEMENT' 'Target app does not own the focused element' }
   WriteText $e $p.text $true; return $true
  }
  'cursor' { $point=New-Object OpenCuaNative+POINT; [void][OpenCuaNative]::GetCursorPos([ref]$point); return @{x=$point.X;y=$point.Y} }
  'screen' { return @{width=[OpenCuaNative]::GetSystemMetrics(0);height=[OpenCuaNative]::GetSystemMetrics(1)} }
  'physical' { Physical $p; return $null }
  'launch' {
   if (-not $env:OPENCUA_DESKTOP) { Fail 'ISOLATED_SESSION_REQUIRED' 'Apps start only on an owned OpenCUA desktop' }
   $list=@($p.args | Where-Object { $_ -is [string] })
   $process=if ($list.Count) { Start-Process -FilePath $p.path -ArgumentList $list -PassThru } else { Start-Process -FilePath $p.path -PassThru }
   return @{pid=$process.Id;desktop=$env:OPENCUA_DESKTOP}
  }
  'postTarget' {
   $top=$null
   if ($null -eq $p.windowId) { foreach ($handle in (Handles $p.pid)) { $b=HandleBounds $handle; if ([int]$p.x -ge $b.x -and [int]$p.x -lt ($b.x+$b.width) -and [int]$p.y -ge $b.y -and [int]$p.y -lt ($b.y+$b.height)) { $top=$handle; break } } }
   if ($null -eq $top) { $top=[IntPtr](Window $p).Current.NativeWindowHandle }
   $h=[OpenCuaNative]::Target($top,[int]$p.x,[int]$p.y)
   $o=New-Object OpenCuaNative+POINT; [void][OpenCuaNative]::ScreenToClient($h,[ref]$o)
   return @{hwnd=$h.ToInt64();originX=-$o.X;originY=-$o.Y}
  }
  'post' {
   foreach ($m in $p.messages) {
    if (-not [OpenCuaNative]::PostMessage([IntPtr][long]$p.hwnd,[uint32]$m.message,[IntPtr][long]$m.wParam,[IntPtr][long]$m.lParam)) { Fail 'POST_FAILED' 'PostMessage failed (possibly UIPI)' }
   }
   return $true
  }
  'loadOcr' { if ($null -eq (Get-Command OpenCuaOcr -ErrorAction SilentlyContinue)) { . ([scriptblock]::Create($p.source)) }; return $true }
  'ocr' {
   if ($null -eq (Get-Command OpenCuaOcr -ErrorAction SilentlyContinue)) { Fail 'OCR_NOT_LOADED' 'Send loadOcr first' }
   $w=Window $p; $image=Capture $w @{format='png'}
   return @{width=$image.width;height=$image.height;bounds=(WindowBounds $w);lines=(OpenCuaOcr @{png=$image.data})}
  }
  'loadAudio' { if (-not ('OpenCuaAudio' -as [type])) { Add-Type -TypeDefinition $p.source }; return $true }
  'audio' {
   if (-not ('OpenCuaAudio' -as [type])) { Fail 'AUDIO_NOT_LOADED' 'Send loadAudio first' }
   $parents=@{}
   Get-CimInstance Win32_Process | ForEach-Object { $parents[[string]$_.ProcessId]=[int]$_.ParentProcessId }
   return @{sessions=@([OpenCuaAudio]::Sessions() | ForEach-Object { @{pid=$_['pid'];peak=$_['peak'];state=$_['state']} });parents=$parents}
  }
  'audioRecord' {
   if (-not ('OpenCuaAudio' -as [type])) { Fail 'AUDIO_NOT_LOADED' 'Send loadAudio first' }
   if (-not ($p.pid -is [int] -or $p.pid -is [long]) -or $p.pid -le 0 -or -not ($p.seconds -gt 0 -and $p.seconds -le 10)) { Fail 'INVALID_ARGUMENT' 'audioRecord needs a pid and 0 < seconds <= 10' }
   return @{mimeType='audio/wav';data=[Convert]::ToBase64String([OpenCuaAudio]::Record([int]$p.pid,[double]$p.seconds))}
  }
  default { Fail 'UNSUPPORTED' ('Unknown method: '+$method) }
 }
}
while ($null -ne ($line=[Console]::ReadLine())) {
 $request=$null
 try {
  $request=ConvertFrom-Json $line
  $result=Dispatch $request.method $request.params
  $response=@{id=$request.id;result=$result}
 } catch {
  $message=$_.Exception.Message; $code='UIA_ERROR'
  if ($_.Exception.GetBaseException() -is [System.Windows.Automation.ElementNotAvailableException]) { $code='STALE_REF' }
  if ($message -match '^([A-Z_]+)\|(.*)$') { $code=$Matches[1];$message=$Matches[2] }
  $response=@{id=$request.id;error=@{code=$code;message=$message}}
 }
 [Console]::WriteLine((ConvertTo-Json -InputObject $response -Depth 100 -Compress))
}
`;
