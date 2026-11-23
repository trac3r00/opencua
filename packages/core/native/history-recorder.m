#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#import <fcntl.h>
#import <spawn.h>
#import <sys/file.h>
#import <sys/wait.h>

extern Boolean IsSecureEventInputEnabled(void);
extern char **environ;
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attributes,
                                                 int disclaim);
// Private but long-stable HIServices call (opencua's AX snapshot uses it too):
// the CGWindowID behind an AX window element.
extern AXError _AXUIElementGetWindow(AXUIElementRef element,
                                     CGWindowID *identifier)
    __attribute__((weak_import));

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
// Backstop only: `opencua history summarize` deletes summarized raw segments
// after rawRetentionHours (default 48); this removes anything older that it
// missed.
static const double kRetentionSeconds = 48 * 60 * 60;

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

// Every AX read is bounded: an app that hangs costs this recorder at most this
// long per read instead of stalling input capture.
static const float kAXReadTimeoutSeconds = 0.05f;
static const NSUInteger kContextTextLimit = 200;
static const NSUInteger kContextURLLimit = 2048;
static BOOL gAXTrusted = NO;

static void BoundAXReads(void) {
  AXUIElementRef systemWide = AXUIElementCreateSystemWide();
  AXUIElementSetMessagingTimeout(systemWide, kAXReadTimeoutSeconds);
  CFRelease(systemWide);
}

static NSString *Clipped(NSString *text, NSUInteger limit) {
  return text.length > limit
             ? [text substringWithRange:
                         [text rangeOfComposedCharacterSequencesForRange:
                                   NSMakeRange(0, limit)]]
             : text;
}

static NSString *ContextText(id value) {
  if (![value isKindOfClass:NSString.class]) {
    return nil;
  }
  NSString *text = [value
      stringByTrimmingCharactersInSet:NSCharacterSet
                                          .whitespaceAndNewlineCharacterSet];
  return text.length > 0 ? Clipped(text, kContextTextLimit) : nil;
}

// Role and labels of an element, in the order ElementFields reads them, then
// its window and URL. AXValue is never read: what a field holds is not history.
static NSArray<NSString *> *ElementAttributeNames(void) {
  return @[
    @"AXRole", @"AXSubrole", @"AXTitle", @"AXDescription", @"AXIdentifier",
    @"AXPlaceholderValue", @"AXWindow", @"AXURL"
  ];
}

// The contract's `element`: {role, subrole?, title?, description?,
// identifier?, placeholder?}; nil without a role.
static NSDictionary *ElementFields(NSArray *values) {
  NSString *role = values.count >= 6 ? ContextText(values[0]) : nil;
  if (role == nil) {
    return nil;
  }
  NSMutableDictionary *element =
      [NSMutableDictionary dictionaryWithObject:role forKey:@"role"];
  NSArray<NSString *> *keys =
      @[ @"subrole", @"title", @"description", @"identifier", @"placeholder" ];
  for (NSUInteger index = 0; index < keys.count; index++) {
    NSString *text = ContextText(values[index + 1]);
    if (text != nil) {
      element[keys[index]] = text;
    }
  }
  return element;
}

static BOOL IsSecureElement(NSDictionary *element) {
  return [element[@"role"] isEqual:@"AXSecureTextField"] ||
         [element[@"subrole"] isEqual:@"AXSecureTextField"];
}

// The contract's `document`: AXDocument is a URL string and AXURL a CFURL;
// file URLs become `path`, anything else `url`. nil when neither says.
static NSDictionary *DocumentFields(id document, id url) {
  NSMutableDictionary *fields = [NSMutableDictionary dictionary];
  for (id value in @[ url ?: NSNull.null, document ?: NSNull.null ]) {
    NSURL *parsed = [value isKindOfClass:NSURL.class] ? value
                    : [value isKindOfClass:NSString.class]
                        ? [NSURL URLWithString:value]
                        : nil;
    if (parsed.scheme.length == 0) {
      continue;
    }
    if (parsed.isFileURL) {
      if (fields[@"path"] == nil && parsed.path.length > 0) {
        fields[@"path"] = parsed.path;
      }
    } else if (fields[@"url"] == nil) {
      fields[@"url"] = Clipped(parsed.absoluteString, kContextURLLimit);
    }
  }
  return fields.count > 0 ? fields : nil;
}

static NSArray *CopyAttributes(AXUIElementRef element,
                               NSArray<NSString *> *names) {
  CFArrayRef values = NULL;
  if (AXUIElementCopyMultipleAttributeValues(
          element, (__bridge CFArrayRef)names, 0, &values) != kAXErrorSuccess ||
      values == NULL) {
    return nil;
  }
  NSArray *copied = CFBridgingRelease(values);
  return copied.count == names.count ? copied : nil;
}

static BOOL IsAXElement(id value) {
  return value != nil &&
         CFGetTypeID((__bridge CFTypeRef)value) == AXUIElementGetTypeID();
}

static AXUIElementRef CreateAppElement(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (app != NULL) {
    AXUIElementSetMessagingTimeout(app, kAXReadTimeoutSeconds);
  }
  return app;
}

// An element-valued attribute of the app (its focused window or element),
// retained; NULL when AX cannot say.
static AXUIElementRef CopyAppElementAttribute(pid_t pid,
                                              CFStringRef attribute) {
  if (!gAXTrusted) {
    return NULL;
  }
  AXUIElementRef app = CreateAppElement(pid);
  if (app == NULL) {
    return NULL;
  }
  CFTypeRef value = NULL;
  AXError error = AXUIElementCopyAttributeValue(app, attribute, &value);
  CFRelease(app);
  if (error != kAXErrorSuccess || value == NULL) {
    return NULL;
  }
  if (CFGetTypeID(value) != AXUIElementGetTypeID()) {
    CFRelease(value);
    return NULL;
  }
  return (AXUIElementRef)value;
}

// The app's element under a click, retained. A click on another app's window
// (about to come forward) has no element of this app.
static AXUIElementRef CopyElementAtPoint(pid_t pid, CGPoint point) {
  if (!gAXTrusted) {
    return NULL;
  }
  AXUIElementRef app = CreateAppElement(pid);
  if (app == NULL) {
    return NULL;
  }
  AXUIElementRef hit = NULL;
  AXError error = AXUIElementCopyElementAtPosition(app, (float)point.x,
                                                   (float)point.y, &hit);
  CFRelease(app);
  if (error != kAXErrorSuccess || hit == NULL) {
    return NULL;
  }
  pid_t owner = 0;
  if (AXUIElementGetPid(hit, &owner) != kAXErrorSuccess || owner != pid) {
    CFRelease(hit);
    return NULL;
  }
  return hit;
}

static CGWindowID WindowNumber(AXUIElementRef window) {
  CGWindowID identifier = 0;
  if (_AXUIElementGetWindow == NULL ||
      _AXUIElementGetWindow(window, &identifier) != kAXErrorSuccess) {
    return 0;
  }
  return identifier;
}

// What an event acted on, as the contract's optional `element`, `window`
// ({title, windowID}) and `document` fields, ready to merge into the event.
// A NULL element reads only the app's focused window.
static NSDictionary *ReadActedContext(pid_t pid, AXUIElementRef element) {
  NSMutableDictionary *context = [NSMutableDictionary dictionary];
  if (!gAXTrusted) {
    return context;
  }
  id window = nil;
  id webURL = nil;
  if (element != NULL) {
    NSArray *values = CopyAttributes(element, ElementAttributeNames());
    NSDictionary *fields = ElementFields(values);
    if (fields != nil) {
      context[@"element"] = fields;
      if (IsAXElement(values[6])) {
        window = values[6];
      }
      // A browser's page is an AXWebArea whose AXURL is the page address; on
      // any other element (a link) AXURL is where it leads, not the document.
      if ([fields[@"role"] isEqual:@"AXWebArea"]) {
        webURL = values[7];
      }
    }
  }
  if (window == nil) {
    window = CFBridgingRelease(
        CopyAppElementAttribute(pid, kAXFocusedWindowAttribute));
  }
  if (window == nil) {
    return context;
  }
  NSArray *values = CopyAttributes((__bridge AXUIElementRef)window,
                                   @[ @"AXTitle", @"AXDocument", @"AXURL" ]);
  context[@"window"] = @{
    @"title" : ContextText(values.firstObject) ?: @"",
    @"windowID" : @(WindowNumber((__bridge AXUIElementRef)window)),
  };
  NSDictionary *document =
      DocumentFields(values == nil ? nil : values[1],
                     webURL ?: (values == nil ? nil : values[2]));
  if (document != nil) {
    context[@"document"] = document;
  }
  return context;
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

// Typed characters coalesce into one keyboard.text_input per run: the same app
// and focused element, ended by a focus or element change, a non-text key
// (Return, Tab, Escape, arrows), a shortcut, a click, or kTextRunIdleSeconds
// without typing. Backspace edits the pending run; the event keeps the first
// character's timestamp. A run in a secure text field is never written.
static const double kTextRunIdleSeconds = 2.0;
static NSMutableDictionary *gRunEvent = nil;
static NSMutableString *gRunText = nil;
static AXUIElementRef gRunElement = NULL;
static BOOL gRunSecure = NO;
static CFAbsoluteTime gRunLastKey = 0;
static dispatch_source_t gRunIdleTimer = nil;

typedef NS_ENUM(NSInteger, TypedKey) {
  TypedKeyIgnored,
  TypedKeyText,
  TypedKeyBackspace,
  TypedKeyBoundary,
};

static TypedKey ClassifyTypedKey(NSString *chars) {
  if (chars.length == 0) {
    return TypedKeyIgnored; // a dead key: its character comes with the next key
  }
  if (chars.length == 1 && [chars characterAtIndex:0] == 0x7F) {
    return TypedKeyBackspace;
  }
  for (NSUInteger index = 0; index < chars.length; index++) {
    unichar character = [chars characterAtIndex:index];
    // Control characters (Return, Enter, Tab, Escape) and the function-key
    // range AppKit maps arrows, Home, End and forward delete into.
    if (character < 0x20 || character == 0x7F ||
        (character >= 0xF700 && character <= 0xF8FF)) {
      return TypedKeyBoundary;
    }
  }
  return TypedKeyText;
}

static void DiscardTextRun(void) {
  gRunEvent = nil;
  gRunText = nil;
  gRunSecure = NO;
  if (gRunElement != NULL) {
    CFRelease(gRunElement);
    gRunElement = NULL;
  }
}

static void FlushTextRun(void) {
  NSMutableDictionary *event = gRunEvent;
  NSString *text = [gRunText copy];
  BOOL secure = gRunSecure;
  DiscardTextRun();
  // An app excluded since the run began keeps what was typed in it.
  if (event == nil || secure || text.length == 0 ||
      !ShouldObserveApp(event[@"app"][@"bundleIdentifier"])) {
    return;
  }
  event[@"keyboard"] = @{@"text" : text};
  AppendEvent(event);
}

static BOOL SameRunTarget(NSDictionary *app, AXUIElementRef element) {
  if (![gRunEvent[@"app"][@"processIdentifier"]
          isEqual:app[@"processIdentifier"]]) {
    return NO;
  }
  if (gRunElement == NULL || element == NULL) {
    return gRunElement == element;
  }
  return CFEqual(gRunElement, element);
}

static void ArmTextRunIdle(void) {
  if (gRunIdleTimer == nil) {
    gRunIdleTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                           dispatch_get_main_queue());
    dispatch_source_set_event_handler(gRunIdleTimer, ^{
      FlushTextRun();
    });
    dispatch_source_set_timer(gRunIdleTimer, DISPATCH_TIME_FOREVER,
                              DISPATCH_TIME_FOREVER, 0);
    dispatch_resume(gRunIdleTimer);
  }
  dispatch_source_set_timer(
      gRunIdleTimer,
      dispatch_time(DISPATCH_TIME_NOW,
                    (int64_t)(kTextRunIdleSeconds * NSEC_PER_SEC)),
      DISPATCH_TIME_FOREVER, 100 * NSEC_PER_MSEC);
}

// One unmodified key press. element is the app's focused element (NULL when
// AX cannot say); readContext reads its contract fields and runs only when a
// run starts.
static void HandleTypedKey(NSDictionary *app, NSString *chars,
                           AXUIElementRef element,
                           NSDictionary * (^readContext)(void)) {
  TypedKey kind = ClassifyTypedKey(chars);
  if (kind == TypedKeyIgnored) {
    return;
  }
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
  if (gRunEvent != nil &&
      (kind == TypedKeyBoundary || now - gRunLastKey >= kTextRunIdleSeconds ||
       !SameRunTarget(app, element))) {
    FlushTextRun();
  }
  if (kind == TypedKeyBoundary) {
    return;
  }
  if (kind == TypedKeyBackspace) {
    if (gRunEvent == nil) {
      return; // nothing pending to edit
    }
    if (gRunText.length > 0) {
      [gRunText
          deleteCharactersInRange:
              [gRunText
                  rangeOfComposedCharacterSequenceAtIndex:gRunText.length - 1]];
    }
  } else {
    if (gRunEvent == nil) {
      gRunEvent = EventShell(@"keyboard.text_input", app);
      NSDictionary *context = readContext();
      [gRunEvent addEntriesFromDictionary:context];
      // A field AX cannot name (timed out, untrusted, unresponsive app) may be
      // a password field that does not turn on Secure Event Input, so its text
      // is not written.
      gRunSecure = element == NULL || context[@"element"] == nil ||
                   IsSecureElement(context[@"element"]);
      gRunText = [NSMutableString string];
      gRunElement = element != NULL ? (AXUIElementRef)CFRetain(element) : NULL;
    }
    if (!gRunSecure) {
      [gRunText appendString:chars];
    }
  }
  gRunLastKey = now;
  ArmTextRunIdle();
}

// The contract's keyboard.shortcut `modifiers`: the held modifiers, in this
// order and spelling.
static NSArray<NSString *> *ModifierNames(CGEventFlags flags) {
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  if (flags & kCGEventFlagMaskCommand)
    [names addObject:@"command"];
  if (flags & kCGEventFlagMaskShift)
    [names addObject:@"shift"];
  if (flags & kCGEventFlagMaskAlternate)
    [names addObject:@"option"];
  if (flags & kCGEventFlagMaskControl)
    [names addObject:@"control"];
  return names;
}

// A shortcut or click ends the pending text run, so the run is written first.
static void RecordInput(NSString *kind, NSDictionary *app, NSString *field,
                        NSDictionary *payload, NSDictionary *context) {
  FlushTextRun();
  NSMutableDictionary *event = EventShell(kind, app);
  [event addEntriesFromDictionary:context];
  event[field] = payload;
  AppendEvent(event);
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
  NSDictionary *context =
      ReadActedContext([app[@"processIdentifier"] intValue], NULL);
  NSDictionary *window = context[@"window"] ?: @{
    @"windowID" : @0,
    @"title" : @""
  };
  NSString *windowKey =
      [NSString stringWithFormat:@"%@\t%@\t", bundleId, window[@"windowID"]];
  NSString *focusKey = [windowKey stringByAppendingString:window[@"title"]];
  if ([focusKey isEqualToString:gLastFocusKey]) {
    return;
  }
  // Another app or window ends the run; a title change (a document marked
  // edited by the typing itself) does not.
  if (![gLastFocusKey hasPrefix:windowKey]) {
    FlushTextRun();
  }
  gLastFocusKey = focusKey;
  if (!ShouldObserveApp(bundleId)) {
    RecordSuppressed();
    return;
  }
  NSMutableDictionary *event = EventShell(@"window.changed", app);
  event[@"window"] = window;
  if (context[@"document"] != nil) {
    event[@"document"] = context[@"document"];
  }
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
  pid_t pid = [app[@"processIdentifier"] intValue];
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
      AXUIElementRef focused =
          CopyAppElementAttribute(pid, kAXFocusedUIElementAttribute);
      RecordInput(@"keyboard.shortcut", app, @"keyboard", @{
        @"keyEquivalent" : text,
        @"modifiers" : ModifierNames(flags),
      },
                  ReadActedContext(pid, focused));
      if (focused != NULL) {
        CFRelease(focused);
      }
    } else if (!IsSecureEventInputEnabled()) {
      UniChar chars[16];
      UniCharCount length = 0;
      CGEventKeyboardGetUnicodeString(cgEvent, 16, &length, chars);
      if (length > 0) {
        AXUIElementRef focused =
            CopyAppElementAttribute(pid, kAXFocusedUIElementAttribute);
        HandleTypedKey(app, [NSString stringWithCharacters:chars length:length],
                       focused, ^NSDictionary * {
                         return ReadActedContext(pid, focused);
                       });
        if (focused != NULL) {
          CFRelease(focused);
        }
      }
    } else {
      // Secure input took over: the run in the previous field is complete.
      FlushTextRun();
    }
  } else {
    NSString *button = (type == kCGEventRightMouseDown)   ? @"right"
                       : (type == kCGEventOtherMouseDown) ? @"other"
                                                          : @"left";
    AXUIElementRef hit = CopyElementAtPoint(pid, CGEventGetLocation(cgEvent));
    RecordInput(@"mouse.click", app, @"mouse", @{@"button" : button},
                ReadActedContext(pid, hit));
    if (hit != NULL) {
      CFRelease(hit);
    }
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

static NSString *BuddySpeakingPath(void) {
  return [gRoot.stringByDeletingLastPathComponent
      stringByAppendingPathComponent:@"buddy/speaking.pid"];
}

// Runs `<launcher> arguments...` disclaimed, as cursor-overlay starts buddy
// settings: a child charged to this helper's privacy identity could not reach
// the network. finished gets the exit status (-1 when unknown) on the main
// queue. Returns NO when the launcher could not be started.
static BOOL RunLauncher(NSArray<NSString *> *arguments,
                        void (^finished)(int status)) {
  NSArray<NSString *> *command =
      [@[ HistoryLauncherPath() ] arrayByAddingObjectsFromArray:arguments];
  char **argv = calloc(command.count + 1, sizeof(char *));
  for (NSUInteger index = 0; index < command.count; index++) {
    argv[index] = (char *)command[index].UTF8String;
  }
  posix_spawnattr_t attributes;
  posix_spawnattr_init(&attributes);
  responsibility_spawnattrs_setdisclaim(&attributes, 1);
  posix_spawn_file_actions_t files;
  posix_spawn_file_actions_init(&files);
  posix_spawn_file_actions_addopen(&files, STDIN_FILENO, "/dev/null", O_RDONLY,
                                   0);
  posix_spawn_file_actions_addopen(&files, STDOUT_FILENO, "/dev/null", O_WRONLY,
                                   0);
  posix_spawn_file_actions_addopen(&files, STDERR_FILENO, "/dev/null", O_WRONLY,
                                   0);
  pid_t pid = 0;
  int error = posix_spawn(&pid, argv[0], &files, &attributes, argv, environ);
  posix_spawn_file_actions_destroy(&files);
  posix_spawnattr_destroy(&attributes);
  free(argv);
  if (error != 0) {
    return NO;
  }
  // Reaped here: nothing else in this process waits on the child.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    int status = 0;
    pid_t reaped;
    do {
      reaped = waitpid(pid, &status, 0);
    } while (reaped < 0 && errno == EINTR);
    int code = reaped == pid && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    dispatch_async(dispatch_get_main_queue(), ^{
      finished(code);
    });
  });
  return YES;
}

static void ShowLauncherUnavailable(void) {
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"Could not reach the opencua launcher";
  alert.informativeText = @"Run setup, then restart history recording to "
                           "refresh its launcher path.";
  [alert runModal];
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
  BoundAXReads();
  gAXTrusted = AXIsProcessTrusted();
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
  gStatusItem.menu = [self buildMenu];
}

// opencua's one menu bar menu: history, then the agent and buddy controls the
// cursor-overlay status helper shows while this recorder is not running.
- (NSMenu *)buildMenu {
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
  [menu addItemWithTitle:@"Open timeline"
                  action:@selector(openTimeline:)
           keyEquivalent:@""]
      .target = self;
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
  [menu addItemWithTitle:@"Stop buddy talking"
                  action:@selector(stopBuddyTalking:)
           keyEquivalent:@""]
      .target = self;
  [menu addItemWithTitle:@"Buddy settings\u2026"
                  action:@selector(openBuddySettings:)
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
  NSMenuItem *clear = [[NSMenuItem alloc] initWithTitle:@"Clear history"
                                                 action:NULL
                                          keyEquivalent:@""];
  clear.submenu = [[NSMenu alloc] initWithTitle:@"Clear history"];
  for (NSArray<NSString *> *span in @[
         @[ @"Last 10 minutes", @"10m" ], @[ @"Last hour", @"1h" ],
         @[ @"Last day", @"1d" ], @[ @"All", @"all" ]
       ]) {
    NSMenuItem *item = [clear.submenu addItemWithTitle:span[0]
                                                action:@selector(clearHistory:)
                                         keyEquivalent:@""];
    item.target = self;
    item.representedObject = span[1];
  }
  [menu addItem:clear];
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
  return menu;
}

- (void)runLauncher:(NSArray<NSString *> *)arguments
            failure:(NSString *)failure {
  if (!RunLauncher(arguments, ^(int status) {
        if (status != 0) {
          gStatusItem.button.toolTip = failure;
        }
      })) {
    ShowLauncherUnavailable();
  }
}

- (void)openTimeline:(id)sender {
  (void)sender;
  [self runLauncher:@[ @"history", @"timeline", @"--open" ]
            failure:@"Could not open the timeline."];
}

- (void)stopBuddyTalking:(id)sender {
  (void)sender;
  [self runLauncher:@[ @"buddy", @"stop" ]
            failure:@"Could not stop buddy talking."];
}

- (void)openBuddySettings:(id)sender {
  (void)sender;
  [self runLauncher:@[ @"buddy", @"settings" ]
            failure:@"Could not open buddy settings."];
}

// Clearing deletes recorded events and memories, so it asks first.
- (void)clearHistory:(NSMenuItem *)sender {
  NSString *span = sender.representedObject;
  if (![span isKindOfClass:NSString.class]) {
    return;
  }
  NSAlert *alert = [[NSAlert alloc] init];
  alert.alertStyle = NSAlertStyleWarning;
  alert.messageText =
      [span isEqualToString:@"all"]
          ? @"Clear all recorded history?"
          : [NSString stringWithFormat:@"Clear history from the %@?",
                                       sender.title.lowercaseString];
  alert.informativeText =
      @"Recorded activity from that period is deleted. This cannot be undone.";
  [alert addButtonWithTitle:@"Clear"];
  [alert addButtonWithTitle:@"Cancel"];
  // An accessory app's alert takes Return and Escape only once active.
  [NSApp activate];
  if ([alert runModal] != NSAlertFirstButtonReturn) {
    return;
  }
  // Text typed in the cleared period must not be written after the clear.
  DiscardTextRun();
  [self runLauncher:@[ @"history", @"clear", @"--last", span ]
            failure:@"Could not clear history."];
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
    ShowLauncherUnavailable();
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
  gAXTrusted = AXIsProcessTrusted();
  BOOL wasPaused = gPaused;
  LoadState();
  LoadSettings();
  if (!wasPaused && gPaused) {
    FlushTextRun(); // typed while recording, so it is kept
  }
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
  FlushTextRun();
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
  if (item.action == @selector(stopBuddyTalking:))
    return [NSFileManager.defaultManager fileExistsAtPath:BuddySpeakingPath()];
  return YES;
}

- (void)reveal:(id)sender {
  (void)sender;
  [NSWorkspace.sharedWorkspace
      activateFileViewerSelectingURLs:@[ [NSURL fileURLWithPath:gRoot] ]];
}

- (void)quit:(id)sender {
  (void)sender;
  FlushTextRun();
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
