/**
 * PowerShell for the Windows helper's "ocr" request, sent once per helper process with "loadOcr"
 * (like the audio code) so the startup script stays inside the command-line limit. It runs the
 * built-in Windows.Media.Ocr engine (Windows PowerShell 5.1 WinRT projection) on a PNG and returns
 * lines with word boxes in image pixels.
 */
export const windowsOcrSource = String.raw`
if ($PSVersionTable.PSEdition -eq 'Core') { Fail 'OCR_UNAVAILABLE' 'Windows OCR needs Windows PowerShell 5.1 (WinRT projection); PowerShell 7 has none' }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$global:OpenCuaAsTask=([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
 $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
})[0]
function global:OpenCuaAwait($operation,$type) {
 $task=$global:OpenCuaAsTask.MakeGenericMethod($type).Invoke($null,@($operation))
 if (-not $task.Wait(10000)) { Fail 'OCR_FAILED' 'OCR timed out' }
 return $task.Result
}
function global:OpenCuaOcr($p) {
 $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
 if ($null -eq $engine) { Fail 'OCR_UNAVAILABLE' 'No OCR language pack is installed for the user profile languages' }
 $bytes=[Convert]::FromBase64String($p.png)
 $stream=[Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
 $writer=[Windows.Storage.Streams.DataWriter]::new($stream)
 $writer.WriteBytes($bytes)
 $null=OpenCuaAwait ($writer.StoreAsync()) ([uint32])
 $null=$writer.DetachStream(); $stream.Seek(0)
 $decoder=OpenCuaAwait ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
 $bitmap=OpenCuaAwait ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
 $result=OpenCuaAwait ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
 return ,@($result.Lines | ForEach-Object {
  @{text=$_.Text;words=@($_.Words | ForEach-Object {
   $box=$_.BoundingRect; @{x=$box.X;y=$box.Y;width=$box.Width;height=$box.Height}
  })}
 })
}
`;
