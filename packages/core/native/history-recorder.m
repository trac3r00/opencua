#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#import <fcntl.h>
#import <sys/file.h>

extern Boolean IsSecureEventInputEnabled(void);

static NSString *gRoot = nil;
static NSString *gSegmentsDir = nil;
static NSString *gSettingsPath = nil;
static NSString *gStatePath = nil;

static NSString *gDefaultAppBehavior = @"observe";
static NSMutableSet<NSString *> *gAllowBundleIds = nil;
static NSMutableSet<NSString *> *gBlockBundleIds = nil;
static BOOL gPrivacyPolicySupported = NO;
static NSString *const kPrivacyPolicyError =
    @"Native capture cannot enforce URL or private-browsing exclusions.";

static BOOL gPaused = NO;
static uint64_t gNextId = 1;
static const double kSegmentWindowSeconds = 600.0;
static const double kRetentionSeconds = 6 * 60 * 60;

static NSString *gCurrentSegmentId = nil;
static long gCurrentEventCount = 0;
static long gCurrentSuppressedCount = 0;

static NSString *gLastFocusKey = nil;
static CFMachPortRef gEventTap = NULL;
static BOOL gInputMonitoringActive = NO;
static NSStatusItem *gStatusItem = nil;
static NSTask *gDigestTask = nil;
static time_t gLastDigestWindow = -1;
static NSMenu *gSuggestionsMenu = nil;
static NSMenuItem *gRecordItem = nil;
static NSMenuItem *gExcludeItem = nil;
static BOOL gDemonstrating = NO;
static NSTask *gSuggestTask = nil;
static time_t gLastSuggestWindow = -1;

static NSString *HistoryLauncherPath(void) {
  NSString *configured =
      NSProcessInfo.processInfo.environment[@"OPENCUA_HISTORY_LAUNCHER"]
          ?: NSProcessInfo.processInfo
                 .environment[@"APPLE_CUA_HISTORY_LAUNCHER"];
  if (configured.length > 0)
    return configured;
  NSString *current =
      [NSHomeDirectory() stringByAppendingPathComponent:@".local/bin/opencua"];
  NSString *legacy = [NSHomeDirectory()
      stringByAppendingPathComponent:@".local/bin/apple-cua"];
  NSFileManager *files = NSFileManager.defaultManager;
  return ![files fileExistsAtPath:current] && [files fileExistsAtPath:legacy]
             ? legacy
             : current;
}

static NSString *HomeStateRoot(void) {
  NSString *configured =
      NSProcessInfo.processInfo.environment[@"OPENCUA_STATE_DIR"]
          ?: NSProcessInfo.processInfo.environment[@"APPLE_CUA_STATE_DIR"];
  NSString *current =
      [NSHomeDirectory() stringByAppendingPathComponent:@".opencua"];
  NSString *legacy =
      [NSHomeDirectory() stringByAppendingPathComponent:@".apple-cua"];
  NSFileManager *files = NSFileManager.defaultManager;
  NSString *base = (configured.length > 0)
                       ? configured
                       : (![files fileExistsAtPath:current] &&
                                  [files fileExistsAtPath:legacy]
                              ? legacy
                              : current);
  return [base stringByAppendingPathComponent:@"cua-history"];
}

// cua-history owns opencua's single menu bar item while it runs: holding this
// lock tells the agent Stop helper to hide, and this menu carries Stop/Resume.
static int gMenubarLock = -1;
static void EnsureDir(NSString *path);

static void AcquireMenubarLock(NSString *stateBase) {
  EnsureDir(stateBase);
  int fd =
      open([stateBase stringByAppendingPathComponent:@"menubar-history.lock"]
               .fileSystemRepresentation,
           O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (fd >= 0 && flock(fd, LOCK_EX | LOCK_NB) == 0) {
    gMenubarLock = fd;
  } else if (fd >= 0) {
    close(fd);
  }
}

// The machine-wide StopSwitch file every opencua agent reads before input.
static NSString *AgentStopPath(void) {
  return [gRoot.stringByDeletingLastPathComponent
      stringByAppendingPathComponent:@"stop.json"];
}

static NSString *IsoAt(time_t seconds, BOOL dashes) {
  struct tm parts;
  gmtime_r(&seconds, &parts);
  char buffer[32];
  strftime(buffer, sizeof(buffer),
           dashes ? "%Y-%m-%dT%H-%M-%SZ" : "%Y-%m-%dT%H:%M:%SZ", &parts);
  return [NSString stringWithUTF8String:buffer];
}

static time_t WindowStart(time_t now) {
  return (time_t)(floor((double)now / kSegmentWindowSeconds) *
                  kSegmentWindowSeconds);
}

static void EnsureDir(NSString *path) {
  [NSFileManager.defaultManager createDirectoryAtPath:path
                          withIntermediateDirectories:YES
                                           attributes:@{
                                             NSFilePosixPermissions : @0700
                                           }
                                                error:NULL];
}

static NSString *SegmentDir(NSString *segmentId) {
  return [gSegmentsDir stringByAppendingPathComponent:segmentId];
}

static void WriteMetadata(NSString *segmentId, time_t start) {
  NSDictionary *metadata = @{
    @"id" : segmentId,
    @"startedAt" : IsoAt(start, NO),
    @"endedAt" : IsoAt(start + (time_t)kSegmentWindowSeconds, NO),
    @"eventCount" : @(gCurrentEventCount),
    @"suppressedEventCount" : @(gCurrentSuppressedCount),
    @"eventsPath" :
        [SegmentDir(segmentId) stringByAppendingPathComponent:@"events.jsonl"],
  };
  NSData *data =
      [NSJSONSerialization dataWithJSONObject:metadata
                                      options:NSJSONWritingPrettyPrinted
                                        error:NULL];
  [data writeToFile:[SegmentDir(segmentId)
                        stringByAppendingPathComponent:@"metadata.json"]
         atomically:YES];
}

static void PruneOldSegments(time_t now) {
  NSArray<NSString *> *entries =
      [NSFileManager.defaultManager contentsOfDirectoryAtPath:gSegmentsDir
                                                        error:NULL];
  for (NSString *entry in entries) {
    if (entry.length != 20) {
      continue;
    }
    struct tm parts;
    memset(&parts, 0, sizeof(parts));
    const char *end = strptime(entry.UTF8String, "%Y-%m-%dT%H-%M-%SZ", &parts);
    if (end == NULL || *end != '\0') {
      continue;
    }
    time_t start = timegm(&parts);
    if (![entry isEqualToString:IsoAt(start, YES)] ||
        ![[NSFileManager.defaultManager attributesOfItemAtPath:SegmentDir(entry)
                                                         error:NULL][NSFileType]
            isEqualToString:NSFileTypeDirectory]) {
      continue;
    }
    if (start + (time_t)kSegmentWindowSeconds <
        now - (time_t)kRetentionSeconds) {
      [NSFileManager.defaultManager removeItemAtPath:SegmentDir(entry)
                                               error:NULL];
    }
  }
}

static void SeedSegmentCounts(NSString *segmentId) {
  gCurrentEventCount = 0;
  gCurrentSuppressedCount = 0;
  NSString *events = [NSString
      stringWithContentsOfFile:
          [SegmentDir(segmentId) stringByAppendingPathComponent:@"events.jsonl"]
                      encoding:NSUTF8StringEncoding
                         error:NULL];
  if (events.length > 0) {
    for (NSString *line in [events componentsSeparatedByString:@"\n"]) {
      if (line.length > 0) {
        gCurrentEventCount += 1;
      }
    }
  }
  NSData *metaData =
      [NSData dataWithContentsOfFile:
                  [SegmentDir(segmentId)
                      stringByAppendingPathComponent:@"metadata.json"]];
  if (metaData != nil) {
    NSDictionary *meta = [NSJSONSerialization JSONObjectWithData:metaData
                                                         options:0
                                                           error:NULL];
    if ([meta isKindOfClass:NSDictionary.class] &&
        [meta[@"suppressedEventCount"] isKindOfClass:NSNumber.class]) {
      gCurrentSuppressedCount = [meta[@"suppressedEventCount"] longValue];
    }
  }
  if (gNextId <= (uint64_t)gCurrentEventCount) {
    gNextId = (uint64_t)gCurrentEventCount + 1;
  }
}

static NSString *RollSegment(time_t now) {
  time_t start = WindowStart(now);
  NSString *segmentId = IsoAt(start, YES);
  // A segment the person deleted (opencua history delete) is started again
  // rather than written into a directory that no longer exists, so recording
  // continues and its counts restart from what is on disk.
  if (![segmentId isEqualToString:gCurrentSegmentId] ||
      ![NSFileManager.defaultManager fileExistsAtPath:SegmentDir(segmentId)]) {
    gCurrentSegmentId = segmentId;
    EnsureDir(SegmentDir(segmentId));
    SeedSegmentCounts(segmentId);
    WriteMetadata(segmentId, start);
  }
  return segmentId;
}

static void AppendEvent(NSMutableDictionary *event) {
  time_t now = time(NULL);
  NSString *segmentId = RollSegment(now);
  event[@"id"] = @(gNextId++);
  NSData *line = [NSJSONSerialization dataWithJSONObject:event
                                                 options:0
                                                   error:NULL];
  if (line == nil) {
    return;
  }
  NSString *path =
      [SegmentDir(segmentId) stringByAppendingPathComponent:@"events.jsonl"];
  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
  if (handle == nil) {
    [NSFileManager.defaultManager createFileAtPath:path
                                          contents:nil
                                        attributes:@{
                                          NSFilePosixPermissions : @0600
                                        }];
    handle = [NSFileHandle fileHandleForWritingAtPath:path];
  }
  [handle seekToEndOfFile];
  [handle writeData:line];
  [handle writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
  [handle closeFile];
  gCurrentEventCount += 1;
  WriteMetadata(segmentId, WindowStart(now));
  PruneOldSegments(now);
}

static void RecordSuppressed(void) {
  time_t now = time(NULL);
  NSString *segmentId = RollSegment(now);
  gCurrentSuppressedCount += 1;
  WriteMetadata(segmentId, WindowStart(now));
}

static BOOL ShouldObserveApp(NSString *bundleId) {
  if (!gPrivacyPolicySupported) {
    return NO;
  }
  NSString *key = bundleId.lowercaseString ?: @"";
  if ([gBlockBundleIds containsObject:key]) {
    return NO;
  }
  if ([gAllowBundleIds containsObject:key]) {
    return YES;
  }
  return [gDefaultAppBehavior isEqualToString:@"observe"];
}

static NSDictionary *FrontmostApp(void) {
  NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (app == nil || app.bundleIdentifier == nil) {
    return nil;
  }
  return @{
    @"bundleIdentifier" : app.bundleIdentifier,
    @"name" : app.localizedName ?: app.bundleIdentifier,
    @"processIdentifier" : @(app.processIdentifier),
  };
}

static NSString *FocusedWindowTitle(pid_t pid) {
  if (!AXIsProcessTrusted()) {
    return nil;
  }
  AXUIElementRef appElement = AXUIElementCreateApplication(pid);
  if (appElement == NULL) {
    return nil;
  }
  CFTypeRef window = NULL;
  NSString *title = nil;
  if (AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute,
                                    &window) == kAXErrorSuccess &&
      window != NULL) {
    CFTypeRef titleValue = NULL;
    if (AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXTitleAttribute,
                                      &titleValue) == kAXErrorSuccess &&
        titleValue != NULL) {
      if (CFGetTypeID(titleValue) == CFStringGetTypeID()) {
        title = [(__bridge NSString *)titleValue copy];
      }
      CFRelease(titleValue);
    }
    CFRelease(window);
  }
  CFRelease(appElement);
  return title;
}

static void LoadState(void) {
  NSData *data = [NSData dataWithContentsOfFile:gStatePath];
  if (data == nil) {
    return;
  }
  NSDictionary *state = [NSJSONSerialization JSONObjectWithData:data
                                                        options:0
                                                          error:NULL];
  if ([state isKindOfClass:NSDictionary.class]) {
    // A pause this recorder imposed for an unenforceable policy is not the
    // person's choice: once the policy is supported again, recording resumes.
    BOOL policyHold = [state[@"error"] isEqual:kPrivacyPolicyError];
    gPaused = [state[@"state"] isEqualToString:@"paused"] &&
              !(policyHold && gPrivacyPolicySupported);
  }
}

static void WriteState(NSString *value) {
  NSString *effective =
      !gPrivacyPolicySupported && [value isEqualToString:@"running"] ? @"paused"
                                                                     : value;
  gPaused = [effective isEqualToString:@"paused"];
  NSMutableDictionary *state = [@{
    @"state" : effective,
    @"pid" : @(NSProcessInfo.processInfo.processIdentifier),
    @"updatedAt" : IsoAt(time(NULL), NO),
  } mutableCopy];
  if (!gPrivacyPolicySupported) {
    state[@"error"] = kPrivacyPolicyError;
  }
  NSData *data =
      [NSJSONSerialization dataWithJSONObject:state
                                      options:NSJSONWritingPrettyPrinted
                                        error:NULL];
  EnsureDir(gRoot);
  [data writeToFile:gStatePath atomically:YES];
}

static void LoadSettings(void) {
  [gAllowBundleIds removeAllObjects];
  [gBlockBundleIds removeAllObjects];
  gDefaultAppBehavior = @"observe";
  gPrivacyPolicySupported = NO;
  NSData *data = [NSData dataWithContentsOfFile:gSettingsPath];
  if (data == nil) {
    // No settings yet means the default policy: observe every app, private
    // windows included, until the user excludes an app. Typed text stays off.
    gPrivacyPolicySupported = YES;
    return;
  }
  NSDictionary *settings = [NSJSONSerialization JSONObjectWithData:data
                                                           options:0
                                                             error:NULL];
  if (![settings isKindOfClass:NSDictionary.class]) {
    return;
  }
  gPrivacyPolicySupported =
      [settings[@"observePrivateBrowsing"] isEqual:@YES] &&
      [settings[@"defaultURLBehavior"] isEqual:@"observe"];
  if ([settings[@"defaultApplicationBehavior"] isKindOfClass:NSString.class]) {
    gDefaultAppBehavior = settings[@"defaultApplicationBehavior"];
  }
  NSArray *rules = settings[@"rules"];
  if (![rules isKindOfClass:NSArray.class]) {
    gPrivacyPolicySupported = NO;
    return;
  }
  for (NSDictionary *rule in rules) {
    if (![rule isKindOfClass:NSDictionary.class]) {
      gPrivacyPolicySupported = NO;
      continue;
    }
    if ([rule[@"scope"] isEqual:@"url"]) {
      if (![rule[@"behavior"] isEqual:@"observe"]) {
        gPrivacyPolicySupported = NO;
      }
      continue;
    }
    if (![rule[@"scope"] isEqual:@"app"]) {
      gPrivacyPolicySupported = NO;
      continue;
    }
    NSString *bundleId = rule[@"bundleID"];
    if (![bundleId isKindOfClass:NSString.class]) {
      continue;
    }
    if ([rule[@"behavior"] isEqualToString:@"do_not_observe"]) {
      [gBlockBundleIds addObject:bundleId.lowercaseString];
    } else {
      [gAllowBundleIds addObject:bundleId.lowercaseString];
    }
  }
}

static NSMutableDictionary *EventShell(NSString *kind, NSDictionary *app) {
  NSMutableDictionary *event = [NSMutableDictionary dictionary];
  event[@"kind"] = kind;
  event[@"timestamp"] = IsoAt(time(NULL), NO);
  event[@"app"] = app;
  return event;
}

static void PollFocus(void) {
  if (gPaused || !gPrivacyPolicySupported) {
    return;
  }
  NSDictionary *app = FrontmostApp();
  if (app == nil) {
    return;
  }
  NSString *bundleId = app[@"bundleIdentifier"];
  NSString *title =
      FocusedWindowTitle([app[@"processIdentifier"] intValue]) ?: @"";
  NSString *focusKey = [NSString stringWithFormat:@"%@\t%@", bundleId, title];
  if ([focusKey isEqualToString:gLastFocusKey]) {
    return;
  }
  gLastFocusKey = focusKey;
  if (!ShouldObserveApp(bundleId)) {
    RecordSuppressed();
    return;
  }
  NSMutableDictionary *event = EventShell(@"window.changed", app);
  event[@"window"] = @{@"windowID" : @0, @"title" : title};
  AppendEvent(event);
}

static CGEventRef TapCallback(CGEventTapProxy proxy, CGEventType type,
                              CGEventRef cgEvent, void *info) {
  (void)proxy;
  (void)info;
  if (gPaused || !gPrivacyPolicySupported) {
    return cgEvent;
  }
  if (type == kCGEventTapDisabledByTimeout ||
      type == kCGEventTapDisabledByUserInput) {
    if (gEventTap != NULL) {
      CGEventTapEnable(gEventTap, true);
    }
    return cgEvent;
  }
  NSDictionary *app = FrontmostApp();
  if (app == nil || !ShouldObserveApp(app[@"bundleIdentifier"])) {
    if (app != nil) {
      RecordSuppressed();
    }
    return cgEvent;
  }
  if (type == kCGEventKeyDown) {
    CGEventFlags flags = CGEventGetFlags(cgEvent);
    BOOL hasCommandOrControl =
        (flags & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl)) != 0;
    if (hasCommandOrControl) {
      UniChar chars[8];
      UniCharCount length = 0;
      CGEventKeyboardGetUnicodeString(cgEvent, 8, &length, chars);
      NSString *text = (length > 0)
                           ? [NSString stringWithCharacters:chars length:length]
                           : @"";
      NSMutableDictionary *event = EventShell(@"keyboard.shortcut", app);
      event[@"keyboard"] = @{@"keyEquivalent" : text};
      AppendEvent(event);
    } else if (!IsSecureEventInputEnabled()) {
      UniChar chars[16];
      UniCharCount length = 0;
      CGEventKeyboardGetUnicodeString(cgEvent, 16, &length, chars);
      if (length > 0) {
        NSMutableDictionary *event = EventShell(@"keyboard.text_input", app);
        event[@"keyboard"] =
            @{@"text" : [NSString stringWithCharacters:chars length:length]};
        AppendEvent(event);
      }
    }
  } else {
    NSString *button = (type == kCGEventRightMouseDown)   ? @"right"
                       : (type == kCGEventOtherMouseDown) ? @"other"
                                                          : @"left";
    NSMutableDictionary *event = EventShell(@"mouse.click", app);
    event[@"mouse"] = @{@"button" : button};
    AppendEvent(event);
  }
  return cgEvent;
}

static void InstallEventTap(void) {
  if (gPaused || !gPrivacyPolicySupported || gEventTap != NULL) {
    return;
  }
  CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) |
                     CGEventMaskBit(kCGEventLeftMouseDown) |
                     CGEventMaskBit(kCGEventRightMouseDown) |
                     CGEventMaskBit(kCGEventOtherMouseDown);
  gEventTap =
      CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
                       kCGEventTapOptionListenOnly, mask, TapCallback, NULL);
  if (gEventTap == NULL) {
    gInputMonitoringActive = NO;
    return;
  }
  CFRunLoopSourceRef source =
      CFMachPortCreateRunLoopSource(kCFAllocatorDefault, gEventTap, 0);
  CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
  CFRelease(source);
  CGEventTapEnable(gEventTap, true);
  gInputMonitoringActive = YES;
}

@interface HistoryRecorderDelegate
    : NSObject <NSApplicationDelegate, NSMenuDelegate>
@end

@implementation HistoryRecorderDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  gAllowBundleIds = [NSMutableSet set];
  gBlockBundleIds = [NSMutableSet set];
  gRoot = HomeStateRoot();
  AcquireMenubarLock(gRoot.stringByDeletingLastPathComponent);
  gSegmentsDir = [gRoot stringByAppendingPathComponent:@"segments"];
  gSettingsPath = [gRoot stringByAppendingPathComponent:@"settings.json"];
  gStatePath = [gRoot stringByAppendingPathComponent:@"state.json"];
  EnsureDir(gSegmentsDir);
  LoadSettings();
  LoadState();
  WriteState(gPaused ? @"paused" : @"running");
  [self buildStatusItem];
  InstallEventTap();
  [self refreshStatusTitle];

  NSMutableDictionary *session = EventShell(@"session.started", @{});
  [session removeObjectForKey:@"app"];
  AppendEvent(session);

  [NSTimer scheduledTimerWithTimeInterval:2.0
                                   target:self
                                 selector:@selector(tick:)
                                 userInfo:nil
                                  repeats:YES];
}

- (void)buildStatusItem {
  gStatusItem = [NSStatusBar.systemStatusBar
      statusItemWithLength:NSVariableStatusItemLength];
  NSMenu *menu = [[NSMenu alloc] init];
  NSMenuItem *status =
      [[NSMenuItem alloc] initWithTitle:@"cua-history recording"
                                 action:NULL
                          keyEquivalent:@""];
  status.enabled = NO;
  [menu addItem:status];
  gExcludeItem = [menu addItemWithTitle:@"Don't record this app"
                                 action:@selector(excludeFrontApp:)
                          keyEquivalent:@""];
  gExcludeItem.target = self;
  menu.delegate = self;
  [menu addItem:[NSMenuItem separatorItem]];
  NSMenuItem *suggestions =
      [[NSMenuItem alloc] initWithTitle:@"Suggested skills"
                                 action:NULL
                          keyEquivalent:@""];
  gSuggestionsMenu = [[NSMenu alloc] initWithTitle:@"Suggested skills"];
  gSuggestionsMenu.delegate = self;
  suggestions.submenu = gSuggestionsMenu;
  [menu addItem:suggestions];
  gRecordItem = [menu addItemWithTitle:@"Record a skill"
                                action:@selector(recordSkill:)
                         keyEquivalent:@""];
  gRecordItem.target = self;
  [menu addItem:[NSMenuItem separatorItem]];
  [menu addItemWithTitle:@"Stop all agents"
                  action:@selector(stopAgents:)
           keyEquivalent:@""]
      .target = self;
  [menu addItemWithTitle:@"Resume agents"
                  action:@selector(resumeAgents:)
           keyEquivalent:@""]
      .target = self;
  [menu addItem:[NSMenuItem separatorItem]];
  [menu addItemWithTitle:@"Pause recording"
                  action:@selector(pause:)
           keyEquivalent:@""]
      .target = self;
  [menu addItemWithTitle:@"Resume recording"
                  action:@selector(resume:)
           keyEquivalent:@""]
      .target = self;
  [menu addItem:[NSMenuItem separatorItem]];
  [menu addItemWithTitle:@"Reveal data folder"
                  action:@selector(reveal:)
           keyEquivalent:@""]
      .target = self;
  [menu addItem:[NSMenuItem separatorItem]];
  [menu addItemWithTitle:@"Quit cua-history"
                  action:@selector(quit:)
           keyEquivalent:@""]
      .target = self;
  gStatusItem.menu = menu;
}

- (void)refreshStatusTitle {
  NSString *recordingStatus =
      !gPrivacyPolicySupported ? @"blocked (URL/private exclusions unavailable)"
                               : (gPaused ? @"paused" : @"recording");
  NSString *inputStatus = gInputMonitoringActive ? @"input capture on"
                                                 : @"input capture unavailable";
  NSString *label = [NSString stringWithFormat:@"opencua; cua-history %@; %@",
                                               recordingStatus, inputStatus];
  // Setting the button's image and title lays the status item out again even
  // when nothing changed; that was most of this process's idle CPU.
  // A transient tooltip (a copy or launch failure) replaces the label, so the
  // next tick restores it even when the state did not change.
  static NSString *shownLabel = nil;
  if ([label isEqualToString:shownLabel] &&
      [gStatusItem.button.toolTip isEqualToString:label]) {
    return;
  }
  shownLabel = label;
  NSStatusBarButton *button = gStatusItem.button;
  NSImage *image = [NSImage imageWithSystemSymbolName:@"cursorarrow"
                             accessibilityDescription:@"opencua running"];
  image.template = YES;
  button.image = image;
  button.imagePosition = NSImageLeft;
  button.title = @"opencua";
  button.toolTip = label;
  [button setAccessibilityLabel:label];
  gStatusItem.menu.itemArray.firstObject.title = [NSString
      stringWithFormat:@"cua-history %@; %@", recordingStatus, inputStatus];
}

- (void)refreshSuggestionsFile {
  if (gSuggestTask.running)
    return;
  gSuggestTask = [[NSTask alloc] init];
  gSuggestTask.executableURL = [NSURL fileURLWithPath:HistoryLauncherPath()];
  gSuggestTask.arguments = @[ @"history", @"suggest", @"--write" ];
  gSuggestTask.standardOutput = NSFileHandle.fileHandleWithNullDevice;
  gSuggestTask.standardError = NSFileHandle.fileHandleWithNullDevice;
  if (![gSuggestTask launchAndReturnError:NULL])
    gSuggestTask = nil;
}

// The status menu opens without activating this accessory app, so the
// frontmost application is the one the person was just using.
- (void)refreshExcludeItem {
  NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
  NSString *bundleId = app.bundleIdentifier;
  BOOL usable =
      bundleId.length > 0 &&
      ![bundleId isEqualToString:NSBundle.mainBundle.bundleIdentifier] &&
      ShouldObserveApp(bundleId);
  gExcludeItem.title =
      usable ? [NSString stringWithFormat:@"Don't record \u201C%@\u201D",
                                          app.localizedName ?: bundleId]
             : @"Don't record this app";
  gExcludeItem.representedObject = usable ? bundleId : nil;
}

- (void)excludeFrontApp:(NSMenuItem *)sender {
  NSString *bundleId = sender.representedObject;
  if (![bundleId isKindOfClass:NSString.class]) {
    return;
  }
  NSMutableDictionary *settings = nil;
  NSData *data = [NSData dataWithContentsOfFile:gSettingsPath];
  if (data != nil) {
    id parsed = [NSJSONSerialization JSONObjectWithData:data
                                                options:0
                                                  error:NULL];
    if (![parsed isKindOfClass:NSDictionary.class]) {
      return; // never overwrite settings this recorder cannot read
    }
    settings = [parsed mutableCopy];
  } else {
    settings = [@{
      @"defaultApplicationBehavior" : @"observe",
      @"defaultURLBehavior" : @"observe",
      @"observePrivateBrowsing" : @YES,
      @"rules" : @[],
    } mutableCopy];
  }
  NSMutableArray *rules = [settings[@"rules"] isKindOfClass:NSArray.class]
                              ? [settings[@"rules"] mutableCopy]
                              : [NSMutableArray array];
  [rules addObject:@{
    @"scope" : @"app",
    @"bundleID" : bundleId,
    @"behavior" : @"do_not_observe",
  }];
  settings[@"rules"] = rules;
  NSData *written =
      [NSJSONSerialization dataWithJSONObject:settings
                                      options:NSJSONWritingPrettyPrinted
                                        error:NULL];
  EnsureDir(gRoot);
  [written writeToFile:gSettingsPath atomically:YES];
  LoadSettings();
  [self refreshStatusTitle];
}

- (void)menuNeedsUpdate:(NSMenu *)menu {
  if (menu != gSuggestionsMenu) {
    [self refreshExcludeItem];
    return;
  }
  [menu removeAllItems];
  NSData *data = [NSData
      dataWithContentsOfFile:
          [gRoot stringByAppendingPathComponent:@"skill-suggestions.json"]];
  id parsed = (data != nil && data.length <= 262144)
                  ? [NSJSONSerialization JSONObjectWithData:data
                                                    options:0
                                                      error:NULL]
                  : nil;
  NSArray *items =
      [parsed isKindOfClass:NSDictionary.class] ? parsed[@"suggestions"] : nil;
  NSUInteger shown = 0;
  if ([items isKindOfClass:NSArray.class]) {
    for (NSDictionary *item in items) {
      if (![item isKindOfClass:NSDictionary.class] ||
          ![item[@"title"] isKindOfClass:NSString.class] ||
          ![item[@"prompt"] isKindOfClass:NSString.class])
        continue;
      NSMenuItem *entry = [menu addItemWithTitle:item[@"title"]
                                          action:@selector(copySuggestion:)
                                   keyEquivalent:@""];
      entry.target = self;
      entry.representedObject = item[@"prompt"];
      entry.toolTip = @"Copy a prompt for your agent";
      shown += 1;
      if (shown >= 10)
        break;
    }
  }
  if (shown == 0) {
    NSMenuItem *empty = [menu addItemWithTitle:@"No repeated workflow yet"
                                        action:NULL
                                 keyEquivalent:@""];
    empty.enabled = NO;
  }
  [self refreshSuggestionsFile];
}

- (void)copyToPasteboard:(NSString *)text {
  [NSPasteboard.generalPasteboard clearContents];
  [NSPasteboard.generalPasteboard setString:text
                                    forType:NSPasteboardTypeString];
  gStatusItem.button.toolTip =
      @"Prompt copied. Paste it into your agent to create the skill.";
}

- (void)copySuggestion:(NSMenuItem *)sender {
  if ([sender.representedObject isKindOfClass:NSString.class])
    [self copyToPasteboard:sender.representedObject];
}

- (void)recordSkill:(id)sender {
  (void)sender;
  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:HistoryLauncherPath()];
  BOOL stopping = gDemonstrating;
  task.arguments = stopping ? @[ @"--json", @"history", @"record", @"stop" ]
                            : @[ @"history", @"record", @"start" ];
  NSPipe *output = [NSPipe pipe];
  task.standardOutput = output;
  task.standardError = NSFileHandle.fileHandleWithNullDevice;
  task.terminationHandler = ^(NSTask *finished) {
    NSData *data = [output.fileHandleForReading readDataToEndOfFile];
    int status = finished.terminationStatus;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (status != 0) {
        gStatusItem.button.toolTip =
            stopping ? @"Could not stop the demonstration."
                     : @"Could not start a demonstration. Is recording on?";
        return;
      }
      gDemonstrating = !stopping;
      gRecordItem.title =
          gDemonstrating ? @"Stop recording skill" : @"Record a skill";
      if (stopping) {
        id parsed = [NSJSONSerialization JSONObjectWithData:data
                                                    options:0
                                                      error:NULL];
        if ([parsed isKindOfClass:NSDictionary.class] &&
            [parsed[@"prompt"] isKindOfClass:NSString.class])
          [self copyToPasteboard:parsed[@"prompt"]];
      }
    });
  };
  if (![task launchAndReturnError:NULL]) {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Could not reach the opencua launcher";
    alert.informativeText = @"Run setup, then restart history recording to "
                             "refresh its launcher path.";
    [alert runModal];
  }
}

- (void)summarizeCompletedActivity {
  if (gPaused || gDigestTask.running)
    return;
  time_t window = WindowStart(time(NULL));
  if (window == gLastDigestWindow)
    return;
  NSData *data =
      [NSData dataWithContentsOfFile:
                  [gRoot stringByAppendingPathComponent:@"automation.json"]];
  if (data == nil || data.length > 4096)
    return;
  id settings = [NSJSONSerialization JSONObjectWithData:data
                                                options:0
                                                  error:NULL];
  if (![settings isKindOfClass:NSDictionary.class] ||
      ![settings[@"enabled"] isEqual:@YES])
    return;
  gLastDigestWindow = window;
  gDigestTask = [[NSTask alloc] init];
  gDigestTask.executableURL = [NSURL fileURLWithPath:HistoryLauncherPath()];
  gDigestTask.arguments = @[ @"history", @"digest" ];
  NSError *error = nil;
  if (![gDigestTask launchAndReturnError:&error]) {
    NSDictionary *status = @{@"state" : @"launcher-unavailable"};
    NSData *statusData = [NSJSONSerialization dataWithJSONObject:status
                                                         options:0
                                                           error:NULL];
    [statusData writeToFile:[gRoot stringByAppendingPathComponent:
                                       @"automation-status.json"]
                 atomically:YES];
    gDigestTask = nil;
  }
}

- (void)tick:(NSTimer *)timer {
  (void)timer;
  // Retention is counted in segment windows, so pruning once a minute is
  // enough; listing the segment directory every tick is not free.
  static time_t lastPrune = 0;
  time_t now = time(NULL);
  if (now - lastPrune >= 60) {
    lastPrune = now;
    PruneOldSegments(now);
  }
  BOOL wasPaused = gPaused;
  LoadState();
  LoadSettings();
  if (!gPrivacyPolicySupported && !gPaused) {
    WriteState(@"paused");
  } else if (wasPaused && !gPaused) {
    InstallEventTap();
  }
  [self refreshStatusTitle];
  PollFocus();
  [self summarizeCompletedActivity];
  time_t window = WindowStart(time(NULL));
  if (!gPaused && window != gLastSuggestWindow) {
    gLastSuggestWindow = window;
    [self refreshSuggestionsFile];
  }
}

- (void)pause:(id)sender {
  (void)sender;
  WriteState(@"paused");
  [self refreshStatusTitle];
}

- (void)resume:(id)sender {
  (void)sender;
  WriteState(@"running");
  InstallEventTap();
  gLastFocusKey = nil;
  [self refreshStatusTitle];
}

- (void)stopAgents:(id)sender {
  (void)sender;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions |= NSISO8601DateFormatWithFractionalSeconds;
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{
    @"stoppedAt" : [formatter stringFromDate:[NSDate date]],
    @"reason" : @"stopped from the menu bar",
    @"source" : @"menu",
  }
                                                 options:0
                                                   error:nil];
  [data writeToFile:AgentStopPath() atomically:YES];
}

- (void)resumeAgents:(id)sender {
  (void)sender;
  [NSFileManager.defaultManager removeItemAtPath:AgentStopPath() error:nil];
}

- (BOOL)validateMenuItem:(NSMenuItem *)item {
  BOOL stopped =
      [NSFileManager.defaultManager fileExistsAtPath:AgentStopPath()];
  if (item.action == @selector(stopAgents:))
    return !stopped;
  if (item.action == @selector(resumeAgents:))
    return stopped;
  if (item.action == @selector(excludeFrontApp:))
    return item.representedObject != nil;
  return YES;
}

- (void)reveal:(id)sender {
  (void)sender;
  [NSWorkspace.sharedWorkspace
      activateFileViewerSelectingURLs:@[ [NSURL fileURLWithPath:gRoot] ]];
}

- (void)quit:(id)sender {
  (void)sender;
  WriteState(@"stopped");
  [NSApp terminate:nil];
}

@end

int main(int argc, const char *argv[]) {
  (void)argc;
  (void)argv;
  @autoreleasepool {
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    HistoryRecorderDelegate *delegate = [[HistoryRecorderDelegate alloc] init];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
