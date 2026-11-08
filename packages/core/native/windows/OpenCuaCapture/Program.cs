// One Windows.Graphics.Capture frame of one window (HWND), as PNG base64 on stdout. Unlike
// PrintWindow it reads the composed GPU surface, so DirectX/Vulkan/WebView windows are not black,
// and the window may be covered by others. Windows 10 1903+; with IsBorderRequired = false (Windows
// 11 / 10 20348+) no yellow capture border appears on the person's screen.
// Usage: OpenCuaCapture <hwnd decimal>   Exit 2 bad arguments, 3 capture unsupported, 4 no frame.
using System.Runtime.InteropServices;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using WinRT;

internal static class Program {
	[ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	private interface IGraphicsCaptureItemInterop {
		IntPtr CreateForWindow(IntPtr window, in Guid iid);
		IntPtr CreateForMonitor(IntPtr monitor, in Guid iid);
	}

	[DllImport("d3d11.dll", ExactSpelling = true)]
	private static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags,
		IntPtr levels, uint levelCount, uint sdkVersion, out IntPtr device, out int level, out IntPtr context);

	[DllImport("d3d11.dll", ExactSpelling = true)]
	private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

	private static readonly Guid DxgiDevice = new("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
	private static readonly Guid GraphicsCaptureItemId = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");

	private static async Task<int> Main(string[] args) {
		if (args.Length != 1 || !long.TryParse(args[0], out var handle) || handle == 0) {
			Console.Error.WriteLine("usage: OpenCuaCapture <hwnd>");
			return 2;
		}
		if (!GraphicsCaptureSession.IsSupported()) return 3;

		var interop = ActivationFactory.Get("Windows.Graphics.Capture.GraphicsCaptureItem").AsInterface<IGraphicsCaptureItemInterop>();
		var item = GraphicsCaptureItem.FromAbi(interop.CreateForWindow(new IntPtr(handle), GraphicsCaptureItemId));

		Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out var d3d, out _, out var context));
		Marshal.Release(context);
		var dxgiId = DxgiDevice;
		Marshal.ThrowExceptionForHR(Marshal.QueryInterface(d3d, ref dxgiId, out var dxgi));
		Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out var inspectable));
		Marshal.Release(dxgi);
		Marshal.Release(d3d);
		var device = MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
		Marshal.Release(inspectable);

		using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, item.Size);
		var arrived = new TaskCompletionSource<Direct3D11CaptureFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
		pool.FrameArrived += (sender, _) => {
			var frame = sender.TryGetNextFrame();
			if (frame is not null) arrived.TrySetResult(frame);
		};
		using var session = pool.CreateCaptureSession(item);
		try {
			session.IsBorderRequired = false;
		} catch (Exception error) when (error is COMException or UnauthorizedAccessException or InvalidCastException) {
			// Older builds have no borderless capture; the frame is still captured.
		}
		session.IsCursorCaptureEnabled = false;
		session.StartCapture();
		var finished = await Task.WhenAny(arrived.Task, Task.Delay(3000));
		if (finished != arrived.Task) return 4;

		using var captured = await arrived.Task;
		using var bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(captured.Surface, BitmapAlphaMode.Premultiplied);
		using var stream = new InMemoryRandomAccessStream();
		var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
		encoder.SetSoftwareBitmap(bitmap);
		await encoder.FlushAsync();
		var bytes = new byte[stream.Size];
		using var reader = new DataReader(stream.GetInputStreamAt(0));
		await reader.LoadAsync((uint)stream.Size);
		reader.ReadBytes(bytes);
		Console.Out.Write($"{{\"width\":{bitmap.PixelWidth},\"height\":{bitmap.PixelHeight},\"png\":\"{Convert.ToBase64String(bytes)}\"}}");
		return 0;
	}
}
