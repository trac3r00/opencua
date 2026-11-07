// sckit.m — ScreenCaptureKit FFI shim for @opencua/core
//
// Build: see build.sh in the same directory.
//
// Public entry points:
//   sck_capture_main_display_png(w, h, **outBytes, *outLen, *outW, *outH) -> int
//   sckit_capture_window(windowId, maxW, maxH, format, quality, *outLen) -> *bytes
//   sck_free(*bytes) -> void
//   sck_invalidate_cache() -> void   (call after display config change)
//
// Deployment target: macOS 15.0, so SCScreenshotManager and SCContentFilter's geometry are always present.
//
// Memory: returned bytes are malloc'd; caller MUST call sck_free.

#import <CoreAudio/AudioHardware.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreFoundation/CoreFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <limits.h>
#import <math.h>
#import <os/lock.h>
#import <stdatomic.h>
#import <stdint.h>
#import <stdlib.h>
#import <string.h>

#define SCK_OK 0
#define SCK_ERR_NO_SHAREABLE_CONTENT -1
#define SCK_ERR_NO_DISPLAY -2
#define SCK_ERR_CAPTURE_FAILED -3
#define SCK_ERR_ENCODE_FAILED -4
#define SCK_ERR_INVALID_ARGS -5
#define SCK_ERR_TIMEOUT -6

#define SCK_WINDOW_FORMAT_PNG 0
#define SCK_WINDOW_FORMAT_JPEG 1

static const int64_t SCK_TIMEOUT_NANOSECONDS = 5LL * NSEC_PER_SEC;
static const NSTimeInterval SCK_WINDOW_TIMEOUT_SECONDS = 3.0;
static const NSTimeInterval SCK_WINDOW_CACHE_TTL_SECONDS = 2.0;
static const NSUInteger SCK_WINDOW_CACHE_CAPACITY = 32;
static CFStringRef kSckPngUTI = CFSTR("public.png");
static CFStringRef kSckJpegUTI = CFSTR("public.jpeg");

static SCContentFilter *cachedFilter = nil;
static CGDirectDisplayID cachedFilterDisplayID = 0;

static dispatch_queue_t filterCacheQueue(void) {
	static dispatch_queue_t queue = nil;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		queue = dispatch_queue_create(
			"com.macoscua.sckit.filter-cache", DISPATCH_QUEUE_SERIAL);
	});
	return queue;
}

static SCContentFilter *resolveMainDisplayFilter(int *errorOut) {
	__block SCContentFilter *resolved = nil;
	__block int error = SCK_OK;

	dispatch_sync(filterCacheQueue(), ^{
		CGDirectDisplayID mainID = CGMainDisplayID();
		if (cachedFilter != nil && cachedFilterDisplayID == mainID) {
			resolved = cachedFilter;
			return;
		}

		dispatch_semaphore_t shareableDone = dispatch_semaphore_create(0);
		__block SCDisplay *targetDisplay = nil;

		[SCShareableContent
			getShareableContentExcludingDesktopWindows:NO
			onScreenWindowsOnly:NO
			completionHandler:^(SCShareableContent *content, NSError *shareableError) {
				if (shareableError == nil && content != nil) {
					for (SCDisplay *display in content.displays) {
						if (display.displayID == mainID) {
							targetDisplay = display;
							break;
						}
					}
					if (targetDisplay == nil) {
						targetDisplay = content.displays.firstObject;
					}
				}
				dispatch_semaphore_signal(shareableDone);
			}];

		dispatch_time_t shareableDeadline = dispatch_time(
			DISPATCH_TIME_NOW, SCK_TIMEOUT_NANOSECONDS);
		if (dispatch_semaphore_wait(shareableDone, shareableDeadline) != 0) {
			error = SCK_ERR_TIMEOUT;
			return;
		}
		if (targetDisplay == nil) {
			error = SCK_ERR_NO_DISPLAY;
			return;
		}

		cachedFilter = [[SCContentFilter alloc]
			initWithDisplay:targetDisplay
			excludingWindows:@[]];
		cachedFilterDisplayID = mainID;
		resolved = cachedFilter;
	});

	if (errorOut != NULL) {
		*errorOut = error;
	}
	return resolved;
}

static NSData *encodeCGImageAsPNG(CGImageRef image, int maxPixelSize) {
	if (image == NULL) {
		return nil;
	}
	NSMutableData *data = [NSMutableData data];
	CGImageDestinationRef destination = CGImageDestinationCreateWithData(
		(__bridge CFMutableDataRef)data, kSckPngUTI, 1, NULL);
	if (destination == NULL) {
		return nil;
	}
	NSDictionary *properties = @{
		(__bridge NSString *)kCGImageDestinationImageMaxPixelSize: @(maxPixelSize),
	};
	CGImageDestinationAddImage(destination, image, (__bridge CFDictionaryRef)properties);
	BOOL finalized = CGImageDestinationFinalize(destination);
	CFRelease(destination);
	if (!finalized || data.length == 0) {
		return nil;
	}
	return data;
}

static int captureMainDisplayPng(
	int targetPixelWidth,
	int targetPixelHeight,
	uint8_t **outBytes,
	size_t *outLen,
	int *outWidth,
	int *outHeight);

int sck_capture_main_display_png(
	int targetPixelWidth,
	int targetPixelHeight,
	uint8_t **outBytes,
	size_t *outLen,
	int *outWidth,
	int *outHeight) {
	if (outBytes == NULL || outLen == NULL || outWidth == NULL || outHeight == NULL) {
		return SCK_ERR_INVALID_ARGS;
	}
	if (targetPixelWidth <= 0 || targetPixelHeight <= 0) {
		return SCK_ERR_INVALID_ARGS;
	}
	*outBytes = NULL;
	*outLen = 0;
	*outWidth = 0;
	*outHeight = 0;

	return captureMainDisplayPng(
		targetPixelWidth, targetPixelHeight, outBytes, outLen, outWidth, outHeight);
}

static int captureMainDisplayPng(
	int targetPixelWidth,
	int targetPixelHeight,
	uint8_t **outBytes,
	size_t *outLen,
	int *outWidth,
	int *outHeight) {
	int resolveError = SCK_OK;
	SCContentFilter *filter = resolveMainDisplayFilter(&resolveError);
	if (filter == nil) {
		return resolveError == SCK_OK ? SCK_ERR_NO_SHAREABLE_CONTENT : resolveError;
	}

	int maxPixelSize = targetPixelWidth > targetPixelHeight ? targetPixelWidth : targetPixelHeight;

	SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
	config.width = (size_t)targetPixelWidth;
	config.height = (size_t)targetPixelHeight;
	config.showsCursor = YES;
	config.scalesToFit = YES;
	config.pixelFormat = kCVPixelFormatType_32BGRA;

	__block int resultCode = SCK_ERR_CAPTURE_FAILED;
	__block NSData *encodedData = nil;
	__block int producedWidth = 0;
	__block int producedHeight = 0;
	dispatch_semaphore_t captureDone = dispatch_semaphore_create(0);

	[SCScreenshotManager
		captureImageWithFilter:filter
		configuration:config
		completionHandler:^(CGImageRef image, NSError *captureError) {
			if (captureError != nil || image == NULL) {
				resultCode = SCK_ERR_CAPTURE_FAILED;
				dispatch_semaphore_signal(captureDone);
				return;
			}
			producedWidth = (int)CGImageGetWidth(image);
			producedHeight = (int)CGImageGetHeight(image);
			encodedData = encodeCGImageAsPNG(image, maxPixelSize);
			resultCode = (encodedData != nil) ? SCK_OK : SCK_ERR_ENCODE_FAILED;
			dispatch_semaphore_signal(captureDone);
		}];

	dispatch_time_t captureDeadline = dispatch_time(DISPATCH_TIME_NOW, SCK_TIMEOUT_NANOSECONDS);
	if (dispatch_semaphore_wait(captureDone, captureDeadline) != 0) {
		return SCK_ERR_TIMEOUT;
	}
	if (resultCode != SCK_OK || encodedData == nil) {
		return resultCode;
	}

	size_t encodedLength = encodedData.length;
	uint8_t *encodedBuffer = (uint8_t *)malloc(encodedLength);
	if (encodedBuffer == NULL) {
		return SCK_ERR_ENCODE_FAILED;
	}
	memcpy(encodedBuffer, encodedData.bytes, encodedLength);

	*outBytes = encodedBuffer;
	*outLen = encodedLength;
	*outWidth = producedWidth;
	*outHeight = producedHeight;
	return SCK_OK;
}

@interface SCKWindowIdentity : NSObject
@property(nonatomic) pid_t ownerPID;
@property(nonatomic) NSInteger layer;
@property(nonatomic) CGRect frame;
@end
@implementation SCKWindowIdentity
@end

@interface SCKWindowCapturePlan : NSObject
@property(nonatomic, strong) SCContentFilter *filter;
@property(nonatomic, strong) SCStreamConfiguration *configuration;
@property(nonatomic, strong) SCKWindowIdentity *identity;
@property(nonatomic) int32_t maxWidth;
@property(nonatomic) int32_t maxHeight;
@property(nonatomic) NSTimeInterval createdAt;
@end
@implementation SCKWindowCapturePlan
@end

@interface SCKWindowCaptureResult : NSObject
@property(nonatomic, strong) NSData *data;
@end
@implementation SCKWindowCaptureResult
@end

@interface SCKWindowOperationState : NSObject {
@public
	uint32_t windowID;
	atomic_int pendingCallbacks;
	atomic_bool workerFinished;
	atomic_bool gateReleased;
}
@end
@implementation SCKWindowOperationState
- (instancetype)init {
	self = [super init];
	if (self != nil) {
		atomic_init(&pendingCallbacks, 0);
		atomic_init(&workerFinished, false);
		atomic_init(&gateReleased, false);
	}
	return self;
}
@end

static NSMutableDictionary<NSNumber *, SCKWindowCapturePlan *> *windowPlanCache;
// One capture in flight per window: a second capture of the same window is refused while the first runs,
// but captures of different windows proceed concurrently.
static os_unfair_lock activeWindowCapturesLock = OS_UNFAIR_LOCK_INIT;
static NSMutableSet<NSNumber *> *activeWindowCaptures = nil;

static bool acquireWindowCaptureGate(uint32_t windowID) {
	os_unfair_lock_lock(&activeWindowCapturesLock);
	if (activeWindowCaptures == nil) {
		activeWindowCaptures = [NSMutableSet set];
	}
	NSNumber *key = @(windowID);
	bool acquired = ![activeWindowCaptures containsObject:key];
	if (acquired) {
		[activeWindowCaptures addObject:key];
	}
	os_unfair_lock_unlock(&activeWindowCapturesLock);
	return acquired;
}

static void releaseWindowCaptureGate(uint32_t windowID) {
	os_unfair_lock_lock(&activeWindowCapturesLock);
	[activeWindowCaptures removeObject:@(windowID)];
	os_unfair_lock_unlock(&activeWindowCapturesLock);
}

static void releaseWindowCaptureGateIfFinished(SCKWindowOperationState *state) {
	if (!atomic_load(&state->workerFinished) || atomic_load(&state->pendingCallbacks) != 0) {
		return;
	}
	bool expected = false;
	if (atomic_compare_exchange_strong(&state->gateReleased, &expected, true)) {
		releaseWindowCaptureGate(state->windowID);
	}
}

static void windowCallbackStarted(SCKWindowOperationState *state) {
	atomic_fetch_add(&state->pendingCallbacks, 1);
}

static void windowCallbackFinished(SCKWindowOperationState *state) {
	atomic_fetch_sub(&state->pendingCallbacks, 1);
	releaseWindowCaptureGateIfFinished(state);
}

static dispatch_queue_t windowCacheQueue(void) {
	static dispatch_queue_t queue = nil;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		queue = dispatch_queue_create("com.macoscua.sckit.window-cache", DISPATCH_QUEUE_SERIAL);
		windowPlanCache = [NSMutableDictionary dictionary];
	});
	return queue;
}

static dispatch_queue_t windowWorkerQueue(void) {
	static dispatch_queue_t queue = nil;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		queue = dispatch_queue_create("com.macoscua.sckit.window-capture", DISPATCH_QUEUE_CONCURRENT);
	});
	return queue;
}

static BOOL identitiesEqual(SCKWindowIdentity *left, SCKWindowIdentity *right) {
	return left != nil && right != nil && left.ownerPID == right.ownerPID &&
		left.layer == right.layer && CGRectEqualToRect(left.frame, right.frame);
}

static SCKWindowIdentity *currentWindowIdentity(uint32_t windowID) {
	CFArrayRef infoRef = CGWindowListCopyWindowInfo(
		kCGWindowListOptionIncludingWindow, (CGWindowID)windowID);
	if (infoRef == NULL) {
		return nil;
	}
	NSArray<NSDictionary *> *info = CFBridgingRelease(infoRef);
	for (NSDictionary *entry in info) {
		NSNumber *listedID = entry[(id)kCGWindowNumber];
		NSNumber *ownerPID = entry[(id)kCGWindowOwnerPID];
		NSNumber *layer = entry[(id)kCGWindowLayer];
		NSDictionary *bounds = entry[(id)kCGWindowBounds];
		CGRect frame = CGRectZero;
		if (listedID.unsignedIntValue != windowID || ownerPID == nil || layer == nil ||
			bounds == nil || !CGRectMakeWithDictionaryRepresentation(
				(__bridge CFDictionaryRef)bounds, &frame) || !isfinite(frame.origin.x) ||
			!isfinite(frame.origin.y) || !isfinite(frame.size.width) ||
			!isfinite(frame.size.height) || frame.size.width <= 0 || frame.size.height <= 0) {
			continue;
		}
		SCKWindowIdentity *identity = [[SCKWindowIdentity alloc] init];
		identity.ownerPID = ownerPID.intValue;
		identity.layer = layer.integerValue;
		identity.frame = frame;
		return identity;
	}
	return nil;
}

static void evictWindowPlan(uint32_t windowID) {
	dispatch_sync(windowCacheQueue(), ^{
		[windowPlanCache removeObjectForKey:@(windowID)];
	});
}

static SCKWindowCapturePlan *cachedWindowPlan(
	uint32_t windowID,
	int32_t maxWidth,
	int32_t maxHeight,
	SCKWindowIdentity *identity) {
	__block SCKWindowCapturePlan *plan = nil;
	NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
	dispatch_sync(windowCacheQueue(), ^{
		NSArray<NSNumber *> *keys = windowPlanCache.allKeys;
		for (NSNumber *key in keys) {
			if (now - windowPlanCache[key].createdAt >= SCK_WINDOW_CACHE_TTL_SECONDS) {
				[windowPlanCache removeObjectForKey:key];
			}
		}
		SCKWindowCapturePlan *candidate = windowPlanCache[@(windowID)];
		if (candidate != nil && candidate.maxWidth == maxWidth &&
			candidate.maxHeight == maxHeight && identitiesEqual(candidate.identity, identity)) {
			plan = candidate;
		} else if (candidate != nil) {
			[windowPlanCache removeObjectForKey:@(windowID)];
		}
	});
	return plan;
}

static void storeWindowPlan(uint32_t windowID, SCKWindowCapturePlan *plan) {
	dispatch_sync(windowCacheQueue(), ^{
		if (windowPlanCache.count >= SCK_WINDOW_CACHE_CAPACITY &&
			windowPlanCache[@(windowID)] == nil) {
			NSNumber *oldestKey = nil;
			NSTimeInterval oldestTime = DBL_MAX;
			for (NSNumber *key in windowPlanCache) {
				NSTimeInterval createdAt = windowPlanCache[key].createdAt;
				if (createdAt < oldestTime) {
					oldestTime = createdAt;
					oldestKey = key;
				}
			}
			if (oldestKey != nil) {
				[windowPlanCache removeObjectForKey:oldestKey];
			}
		}
		windowPlanCache[@(windowID)] = plan;
	});
}

static dispatch_time_t remainingDeadline(NSTimeInterval startedAt) {
	NSTimeInterval remaining = SCK_WINDOW_TIMEOUT_SECONDS -
		([NSDate timeIntervalSinceReferenceDate] - startedAt);
	if (remaining <= 0) {
		return DISPATCH_TIME_NOW;
	}
	return dispatch_time(DISPATCH_TIME_NOW, (int64_t)(remaining * NSEC_PER_SEC));
}

static SCKWindowCapturePlan *buildWindowPlan(
	uint32_t windowID,
	int32_t maxWidth,
	int32_t maxHeight,
	SCKWindowIdentity *expectedIdentity,
	NSTimeInterval startedAt,
	SCKWindowOperationState *operationState) {
	__block SCShareableContent *shareableContent = nil;
	dispatch_semaphore_t done = dispatch_semaphore_create(0);
	windowCallbackStarted(operationState);
	[SCShareableContent
		getShareableContentExcludingDesktopWindows:NO
		onScreenWindowsOnly:NO
		completionHandler:^(SCShareableContent *content, NSError *error) {
			if (error == nil) {
				shareableContent = content;
			}
			dispatch_semaphore_signal(done);
			windowCallbackFinished(operationState);
		}];
	if (dispatch_semaphore_wait(done, remainingDeadline(startedAt)) != 0 ||
		shareableContent == nil) {
		return nil;
	}

	SCWindow *targetWindow = nil;
	for (SCWindow *window in shareableContent.windows) {
		if (window.windowID == windowID) {
			targetWindow = window;
			break;
		}
	}
	if (targetWindow == nil || targetWindow.owningApplication == nil) {
		return nil;
	}
	SCKWindowIdentity *shareableIdentity = [[SCKWindowIdentity alloc] init];
	shareableIdentity.ownerPID = targetWindow.owningApplication.processID;
	shareableIdentity.layer = targetWindow.windowLayer;
	shareableIdentity.frame = targetWindow.frame;
	if (!identitiesEqual(expectedIdentity, shareableIdentity)) {
		return nil;
	}

	SCContentFilter *filter = [[SCContentFilter alloc]
		initWithDesktopIndependentWindow:targetWindow];
	CGRect contentRect = filter.contentRect;
	if (!isfinite(contentRect.size.width) || !isfinite(contentRect.size.height) ||
		contentRect.size.width <= 0 || contentRect.size.height <= 0) {
		contentRect = targetWindow.frame;
	}
	double nativeWidth = round(contentRect.size.width * filter.pointPixelScale);
	double nativeHeight = round(contentRect.size.height * filter.pointPixelScale);
	if (!isfinite(nativeWidth) || !isfinite(nativeHeight) || nativeWidth < 1 ||
		nativeHeight < 1) {
		return nil;
	}
	double scale = fmin(1.0, fmin((double)maxWidth / nativeWidth,
		(double)maxHeight / nativeHeight));
	size_t outputWidth = (size_t)fmax(1.0, round(nativeWidth * scale));
	size_t outputHeight = (size_t)fmax(1.0, round(nativeHeight * scale));

	SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
	configuration.width = outputWidth;
	configuration.height = outputHeight;
	configuration.showsCursor = NO;
	configuration.scalesToFit = YES;
	configuration.pixelFormat = kCVPixelFormatType_32BGRA;

	SCKWindowCapturePlan *plan = [[SCKWindowCapturePlan alloc] init];
	plan.filter = filter;
	plan.configuration = configuration;
	plan.identity = expectedIdentity;
	plan.maxWidth = maxWidth;
	plan.maxHeight = maxHeight;
	plan.createdAt = [NSDate timeIntervalSinceReferenceDate];
	return plan;
}

static NSData *encodeWindowImage(CGImageRef image, int32_t format, int32_t quality) {
	if (image == NULL) {
		return nil;
	}
	NSMutableData *data = [NSMutableData data];
	CFStringRef type = format == SCK_WINDOW_FORMAT_JPEG ? kSckJpegUTI : kSckPngUTI;
	CGImageDestinationRef destination = CGImageDestinationCreateWithData(
		(__bridge CFMutableDataRef)data, type, 1, NULL);
	if (destination == NULL) {
		return nil;
	}
	NSDictionary *properties = format == SCK_WINDOW_FORMAT_JPEG
		? @{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality:
			  @((double)quality / 100.0)}
		: @{};
	CGImageDestinationAddImage(destination, image, (__bridge CFDictionaryRef)properties);
	BOOL finalized = CGImageDestinationFinalize(destination);
	CFRelease(destination);
	return finalized && data.length > 0 ? data : nil;
}

static NSData *captureWindowData(
	uint32_t windowID,
	int32_t maxWidth,
	int32_t maxHeight,
	int32_t format,
	int32_t quality,
	NSTimeInterval startedAt,
	SCKWindowOperationState *operationState) {
	SCKWindowIdentity *identity = currentWindowIdentity(windowID);
	if (identity == nil) {
		return nil;
	}
	SCKWindowCapturePlan *plan = cachedWindowPlan(
		windowID, maxWidth, maxHeight, identity);
	if (plan == nil) {
		plan = buildWindowPlan(
			windowID, maxWidth, maxHeight, identity, startedAt, operationState);
		if (plan == nil) {
			evictWindowPlan(windowID);
			return nil;
		}
		storeWindowPlan(windowID, plan);
	}

	__block NSData *encoded = nil;
	__block BOOL captureSucceeded = NO;
	dispatch_semaphore_t done = dispatch_semaphore_create(0);
	windowCallbackStarted(operationState);
	[SCScreenshotManager
		captureImageWithFilter:plan.filter
		configuration:plan.configuration
		completionHandler:^(CGImageRef image, NSError *error) {
			if (error == nil && image != NULL) {
				encoded = encodeWindowImage(image, format, quality);
				captureSucceeded = encoded != nil;
			}
			dispatch_semaphore_signal(done);
			windowCallbackFinished(operationState);
		}];
	if (dispatch_semaphore_wait(done, remainingDeadline(startedAt)) != 0 ||
		!captureSucceeded) {
		evictWindowPlan(windowID);
		return nil;
	}
	SCKWindowIdentity *identityAfterCapture = currentWindowIdentity(windowID);
	if (!identitiesEqual(identity, identityAfterCapture)) {
		evictWindowPlan(windowID);
		return nil;
	}
	return encoded;
}

static uint8_t *captureWindow(
	uint32_t windowId,
	int32_t maxWidth,
	int32_t maxHeight,
	int32_t format,
	int32_t quality,
	int32_t *outLen);

uint8_t *sckit_capture_window(
	uint32_t windowId,
	int32_t maxWidth,
	int32_t maxHeight,
	int32_t format,
	int32_t quality,
	int32_t *outLen) {
	if (outLen == NULL) {
		return NULL;
	}
	*outLen = 0;
	if (windowId == 0 || maxWidth <= 0 || maxHeight <= 0 ||
		(format != SCK_WINDOW_FORMAT_PNG && format != SCK_WINDOW_FORMAT_JPEG) ||
		quality < 1 || quality > 100) {
		return NULL;
	}
	return captureWindow(windowId, maxWidth, maxHeight, format, quality, outLen);
}

static uint8_t *captureWindow(
	uint32_t windowId,
	int32_t maxWidth,
	int32_t maxHeight,
	int32_t format,
	int32_t quality,
	int32_t *outLen) {
	if (!acquireWindowCaptureGate(windowId)) {
		return NULL;
	}

	NSTimeInterval startedAt = [NSDate timeIntervalSinceReferenceDate];
	SCKWindowCaptureResult *result = [[SCKWindowCaptureResult alloc] init];
	SCKWindowOperationState *operationState = [[SCKWindowOperationState alloc] init];
	operationState->windowID = windowId;
	dispatch_semaphore_t done = dispatch_semaphore_create(0);
	dispatch_async(windowWorkerQueue(), ^{
		@autoreleasepool {
			result.data = captureWindowData(
				windowId, maxWidth, maxHeight, format, quality, startedAt, operationState);
			atomic_store(&operationState->workerFinished, true);
			releaseWindowCaptureGateIfFinished(operationState);
			dispatch_semaphore_signal(done);
		}
	});

	if (dispatch_semaphore_wait(done, remainingDeadline(startedAt)) != 0) {
		return NULL;
	}
	NSData *data = result.data;
	if (data.length == 0 || data.length > INT32_MAX) {
		return NULL;
	}
	uint8_t *buffer = malloc(data.length);
	if (buffer == NULL) {
		return NULL;
	}
	memcpy(buffer, data.bytes, data.length);
	*outLen = (int32_t)data.length;
	return buffer;
}

void sck_free(uint8_t *bytes) {
	if (bytes != NULL) {
		free(bytes);
	}
}

// Listens to one process's audio output through a CoreAudio process tap for
// durationMs (50..10000) and reports its level: RMS and peak of the float
// samples, and how many samples were heard. Nothing is kept. The tap is
// private and unmuted, so the process keeps playing to its device as before.
// Needs the Audio Capture permission; a refusal returns SCK_ERR_CAPTURE_FAILED.
int32_t sck_measure_process_audio(
	int32_t pid,
	int32_t durationMs,
	double *outRms,
	double *outPeak,
	int64_t *outSamples) {
	if (pid <= 0 || durationMs < 50 || durationMs > 10000 || outRms == NULL ||
		outPeak == NULL || outSamples == NULL) {
		return SCK_ERR_INVALID_ARGS;
	}
	*outRms = 0;
	*outPeak = 0;
	*outSamples = 0;
	@autoreleasepool {
		AudioObjectPropertyAddress translate = {
			kAudioHardwarePropertyTranslatePIDToProcessObject,
			kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
		AudioObjectID process = kAudioObjectUnknown;
		UInt32 size = sizeof(process);
		pid_t qualifier = pid;
		if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &translate,
				sizeof(qualifier), &qualifier, &size, &process) != noErr ||
			process == kAudioObjectUnknown) {
			return SCK_ERR_NO_SHAREABLE_CONTENT;
		}
		CATapDescription *description =
			[[CATapDescription alloc] initStereoMixdownOfProcesses:@[ @(process) ]];
		description.privateTap = YES;
		description.muteBehavior = CATapUnmuted;
		AudioObjectID tap = kAudioObjectUnknown;
		if (AudioHardwareCreateProcessTap(description, &tap) != noErr) {
			return SCK_ERR_CAPTURE_FAILED;
		}
		NSDictionary *aggregate = @{
			@kAudioAggregateDeviceUIDKey : NSUUID.UUID.UUIDString,
			@kAudioAggregateDeviceNameKey : @"opencua surface listener",
			@kAudioAggregateDeviceIsPrivateKey : @YES,
			@kAudioAggregateDeviceTapAutoStartKey : @YES,
			@kAudioAggregateDeviceTapListKey : @[ @{@kAudioSubTapUIDKey : description.UUID.UUIDString} ],
		};
		AudioObjectID device = kAudioObjectUnknown;
		if (AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregate, &device) != noErr) {
			AudioHardwareDestroyProcessTap(tap);
			return SCK_ERR_CAPTURE_FAILED;
		}
		__block double squares = 0;
		__block double peak = 0;
		__block int64_t samples = 0;
		os_unfair_lock *lock = malloc(sizeof(os_unfair_lock));
		*lock = OS_UNFAIR_LOCK_INIT;
		dispatch_queue_t queue = dispatch_queue_create("com.macoscua.sckit.tap", DISPATCH_QUEUE_SERIAL);
		AudioDeviceIOProcID proc = NULL;
		OSStatus created = AudioDeviceCreateIOProcIDWithBlock(&proc, device, queue,
			^(const AudioTimeStamp *now, const AudioBufferList *input, const AudioTimeStamp *inputTime,
				AudioBufferList *output, const AudioTimeStamp *outputTime) {
				double localSquares = 0;
				double localPeak = 0;
				int64_t count = 0;
				for (UInt32 index = 0; input != NULL && index < input->mNumberBuffers; index += 1) {
					const float *data = input->mBuffers[index].mData;
					size_t length = input->mBuffers[index].mDataByteSize / sizeof(float);
					for (size_t sample = 0; data != NULL && sample < length; sample += 1) {
						double value = data[sample];
						if (!isfinite(value)) continue;
						localSquares += value * value;
						localPeak = fmax(localPeak, fabs(value));
						count += 1;
					}
				}
				os_unfair_lock_lock(lock);
				squares += localSquares;
				peak = fmax(peak, localPeak);
				samples += count;
				os_unfair_lock_unlock(lock);
			});
		int32_t result = SCK_OK;
		if (created != noErr || AudioDeviceStart(device, proc) != noErr) {
			result = SCK_ERR_CAPTURE_FAILED;
		} else {
			usleep((useconds_t)durationMs * 1000);
			AudioDeviceStop(device, proc);
		}
		if (proc != NULL) AudioDeviceDestroyIOProcID(device, proc);
		dispatch_sync(queue, ^{
		});
		AudioHardwareDestroyAggregateDevice(device);
		AudioHardwareDestroyProcessTap(tap);
		os_unfair_lock_lock(lock);
		*outRms = samples > 0 ? sqrt(squares / (double)samples) : 0;
		*outPeak = peak;
		*outSamples = samples;
		os_unfair_lock_unlock(lock);
		free(lock);
		return result;
	}
}

void sck_invalidate_cache(void) {
	dispatch_sync(filterCacheQueue(), ^{
		cachedFilter = nil;
		cachedFilterDisplayID = 0;
	});
	dispatch_sync(windowCacheQueue(), ^{
		[windowPlanCache removeAllObjects];
	});
}
