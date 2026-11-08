// Agent cursor artwork is modelled on Cua Driver's built-in `cua.default`
// cursor theme (https://github.com/trycua/cua,
// libs/cua-driver/rust/crates/cursor-overlay/assets/build_default_theme.py:
// CURSOR_PATH, cursor_layers, cue_layers, action_click/observe/scroll).
// Copyright (c) 2025 Cua AI, Inc., MIT licence.
#import <Cocoa/Cocoa.h>
#import <ctype.h>
#import <errno.h>
#import <fcntl.h>
#import <libproc.h>
#import <pthread.h>
#import <signal.h>
#import <stdlib.h>
#import <string.h>
#import <sys/file.h>
#import <sys/socket.h>
#import <sys/un.h>
#import <unistd.h>

@interface OverlayPointerView : NSView
@property(nonatomic, strong) NSNumber *markerKey;
@property(nonatomic) CGFloat heading;
@property(nonatomic) uint64_t generation;
@property(nonatomic) NSTimeInterval arrival;
@property(nonatomic) NSTimeInterval clickStart;
@property(nonatomic) NSTimeInterval keyPressStart;
@property(nonatomic) NSPoint dragAnchor;
@property(nonatomic) BOOL hasDragAnchor;
@property(nonatomic) NSInteger scrollDirection;
@property(nonatomic) double pulse;
@property(nonatomic, strong) NSTimer *cueTimer;
@end

static NSWindow *gWindow = nil;
static NSView *gPointerView = nil;
static NSMutableDictionary<NSNumber *, NSWindow *> *gMarkerWindows = nil;
static NSMutableDictionary<NSNumber *, NSView *> *gMarkerViews = nil;
static NSMutableDictionary<NSNumber *, NSNumber *> *gMarkerModes = nil;
static NSMutableDictionary<NSNumber *, NSTimer *> *gMarkerTimers = nil;
static NSMutableDictionary<NSNumber *, NSWindow *> *gMarkerHighlights = nil;
static NSMutableDictionary<NSNumber *, NSTimer *> *gMarkerHighlightTimers = nil;
static NSWindow *gHighlightWindow = nil;
static NSTimer *gHighlightTimer = nil;
// Click feedback: an expanding ring drawn where a press lands, so a person
// watching can see every click, including accessibility presses that never move
// any pointer.
static NSWindow *gRippleWindow = nil;
static NSTimer *gRippleTimer = nil;
static double gRipple = 0.0; // 0..1 animation phase
static const CGFloat kRippleSize = 72.0;
static BOOL gShown = NO;
static NSTimer *gScootTimer = nil;
static NSPoint gScootFrom;
static NSPoint gScootTo;
static NSTimeInterval gScootStart;

// Cursor MODE: 0 = pointer, 1 = scroll, 2 = thinking/observing, 3 = keyboard.
static int gMode = 0;
static NSInteger gScrollDirection = 0;
static NSTimeInterval gKeyPressStart = 0.0;
static NSPoint gDragAnchor;
static BOOL gHasDragAnchor = NO;
static double gPulse =
    0.0; // 0..1 animation phase for the scroll/observe cue loop
static NSTimer *gPulseTimer = nil;

// Persistent-daemon idle shutdown: when driven over a unix socket the overlay
// outlives any single CLI command, so it self-terminates after this many
// seconds with no command (0 disables — the stdin/legacy mode never times out).
static NSTimer *gIdleTimer = nil;
static double gIdleTimeout = 0.0;

static void reset_idle_timer(void) {
  if (gIdleTimeout <= 0.0) {
    return;
  }
  if (gIdleTimer != nil) {
    [gIdleTimer invalidate];
    gIdleTimer = nil;
  }
  gIdleTimer = [NSTimer timerWithTimeInterval:gIdleTimeout
                                      repeats:NO
                                        block:^(NSTimer *timer) {
                                          (void)timer;
                                          [NSApp terminate:nil];
                                        }];
  [[NSRunLoop mainRunLoop] addTimer:gIdleTimer forMode:NSRunLoopCommonModes];
}

// Cursor geometry. The arrow is authored on Cua's 128-unit theme canvas and
// drawn at kThemeDisplaySize points. The overlay window is a fixed box with
// the arrow tip pinned at (kHotspotX, kHotspotY) from its top-left corner, so
// every screen point the agent targets lands exactly on the tip.
// The box is square with the hotspot at its centre so artwork rotated about the
// tip never clips.
static const CGFloat kOverlaySize = 96.0;
static const CGFloat kHotspotX = 48.0;
static const CGFloat kHotspotY = 48.0;
static const CGFloat kThemeCanvas = 128.0;
static const CGFloat kThemeDisplaySize = 24.0;
// Apex of the rounded tip on the theme canvas. Cua declares (55, 30) - a point
// on the top edge about 3pt right of the visible tip - so we pin the visible
// apex instead: what a person reads as "where it points".
static const CGFloat kThemeTipX = 45.5;
static const CGFloat kThemeTipY = 32.0;
static const CGFloat kThemeFps = 30.0;
static const NSTimeInterval kFadeInDuration = 0.18;
// Longer glide so the cursor visibly travels across the screen (codex-style),
// rather than snapping between points.
static const NSTimeInterval kScootDuration = 0.42;
// Cua's click cue is 20 frames and its looping observe/scroll cues are 48
// frames, both at 30fps.
static const NSTimeInterval kClickDuration = 20.0 / kThemeFps;
static const NSTimeInterval kKeyPressDuration = 0.25;
static const NSTimeInterval kCueLoopDuration = 48.0 / kThemeFps;

static void stop_pulse(void) {
  if (gPulseTimer != nil) {
    [gPulseTimer invalidate];
    gPulseTimer = nil;
  }
  gPulse = 0.0;
  [gPointerView setNeedsDisplay:YES];
}

static void start_pulse(void) {
  if (gPulseTimer != nil) {
    return;
  }
  gPulseTimer = [NSTimer
      scheduledTimerWithTimeInterval:1.0 / 30.0
                             repeats:YES
                               block:^(NSTimer *timer) {
                                 (void)timer;
                                 gPulse += (1.0 / 30.0) / kCueLoopDuration;
                                 if (gPulse > 1.0) {
                                   gPulse -= 1.0;
                                 }
                                 [gPointerView setNeedsDisplay:YES];
                               }];
}

// Generation counter: bumped on every set/trajectory/hide so deferred click
// cues scheduled for an older target cannot fire after a retarget or hide.
static uint64_t gGeneration = 0;
static CGFloat gHeading = M_PI_4; // rest heading
static NSString *gStyle = @"default";
static NSTimer *gTrajTimer = nil;
static double *gTrajSamples = NULL; // count * {t, x, y, heading}
static size_t gTrajCount = 0;
static NSTimeInterval gTrajStart = 0.0;
static NSTimeInterval gTrajArrival = 0.0;
static NSPoint gTrajToOrigin;
static NSStatusItem *gStatusItem = nil;
// What the status item shows now; nil after it was removed.
static NSString *gShownStatus = nil;

static NSWindow *marker_window(NSNumber *key, BOOL create);
static void apply_marker_set(double x, double y, NSNumber *markerKey);
static void apply_direct_set(double x, double y);

static void cancel_trajectory(void) {
  if (gTrajTimer != nil) {
    [gTrajTimer invalidate];
    gTrajTimer = nil;
  }
  free(gTrajSamples);
  gTrajSamples = NULL;
  gTrajCount = 0;
}

// The machine-wide stop switch lives in <state dir>/stop.json, the same file
// StopSwitch in stop-switch.ts reads before every input. The overlay inherits
// OPENCUA_STATE_DIR from the process that spawned it.
static NSString *stop_file_path(void) {
  NSDictionary<NSString *, NSString *> *env =
      NSProcessInfo.processInfo.environment;
  NSString *dir = env[@"OPENCUA_STATE_DIR"];
  if (dir.length == 0) {
    dir = env[@"APPLE_CUA_STATE_DIR"];
  }
  if (dir.length == 0) {
    NSString *current =
        [NSHomeDirectory() stringByAppendingPathComponent:@".opencua"];
    NSString *legacy =
        [NSHomeDirectory() stringByAppendingPathComponent:@".apple-cua"];
    NSFileManager *files = NSFileManager.defaultManager;
    dir = (![files fileExistsAtPath:current] && [files fileExistsAtPath:legacy])
              ? legacy
              : current;
  }
  return [dir stringByAppendingPathComponent:@"stop.json"];
}

static BOOL stop_engaged(void) {
  return [NSFileManager.defaultManager fileExistsAtPath:stop_file_path()];
}

@interface StopMenuTarget : NSObject
- (void)stopAll:(id)sender;
- (void)resumeAll:(id)sender;
@end

static void update_status_item(void);

@implementation StopMenuTarget
- (void)stopAll:(id)sender {
  (void)sender;
  NSString *path = stop_file_path();
  [NSFileManager.defaultManager
            createDirectoryAtPath:path.stringByDeletingLastPathComponent
      withIntermediateDirectories:YES
                       attributes:nil
                            error:nil];
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions |= NSISO8601DateFormatWithFractionalSeconds;
  NSDictionary *record = @{
    @"stoppedAt" : [formatter stringFromDate:[NSDate date]],
    @"reason" : @"stopped from the menu bar",
    @"source" : @"menu",
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:record
                                                 options:0
                                                   error:nil];
  [data writeToFile:path atomically:YES];
  update_status_item();
}
- (void)resumeAll:(id)sender {
  (void)sender;
  [NSFileManager.defaultManager removeItemAtPath:stop_file_path() error:nil];
  update_status_item();
}
@end

static StopMenuTarget *gStopTarget = nil;

// Builds the status menu on first use and refreshes it after: the read-only
// state lines, then Stop all agents (enabled while agents may act) and Resume
// agents (enabled while stopped).
static NSMenu *control_menu(NSMenu *menu, NSArray<NSString *> *lines,
                            BOOL stopped) {
  if (menu == nil) {
    menu = [[NSMenu alloc] initWithTitle:@"opencua"];
    menu.autoenablesItems = NO;
    for (NSString *text in lines) {
      NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:text
                                                    action:NULL
                                             keyEquivalent:@""];
      item.enabled = NO;
      [menu addItem:item];
    }
    [menu addItem:[NSMenuItem separatorItem]];
    if (gStopTarget == nil) {
      gStopTarget = [[StopMenuTarget alloc] init];
    }
    NSMenuItem *stop = [[NSMenuItem alloc] initWithTitle:@"Stop all agents"
                                                  action:@selector(stopAll:)
                                           keyEquivalent:@""];
    stop.target = gStopTarget;
    [menu addItem:stop];
    NSMenuItem *resume = [[NSMenuItem alloc] initWithTitle:@"Resume agents"
                                                    action:@selector(resumeAll:)
                                             keyEquivalent:@""];
    resume.target = gStopTarget;
    [menu addItem:resume];
  }
  for (NSUInteger index = 0; index < lines.count; index++) {
    [menu itemAtIndex:index].title = lines[index];
  }
  [menu itemAtIndex:lines.count + 1].enabled = !stopped;
  [menu itemAtIndex:lines.count + 2].enabled = stopped;
  return menu;
}

static NSArray<NSString *> *status_only_lines(BOOL stopped) {
  return @[
    @"opencua agent controls",
    stopped ? @"State: all agents stopped" : @"State: agents may act",
    @"Keyboard stop: Control+Option+Command",
  ];
}
// --status-only: a persistent menu bar control for the user, with no cursor.
static BOOL gStatusOnly = NO;

// opencua shows one menu bar item, however many servers run, from one helper
// process. Every server starts a status-only helper; it records its server in
// stop-menu-parents and exits at once unless it can take stop-menu.lock. The
// helper holding the lock lives while any recorded server runs. While
// cua-history holds menubar-history.lock, its own menu carries Stop and
// Resume, so the helper shows no item at all.
static int gStopMenuLock = -1;

static int open_state_lock(NSString *name) {
  NSString *dir = stop_file_path().stringByDeletingLastPathComponent;
  [NSFileManager.defaultManager createDirectoryAtPath:dir
                          withIntermediateDirectories:YES
                                           attributes:nil
                                                error:nil];
  return open(
      [dir stringByAppendingPathComponent:name].fileSystemRepresentation,
      O_RDWR | O_CREAT | O_CLOEXEC, 0600);
}

static BOOL hold_stop_menu_lock(void) {
  if (gStopMenuLock >= 0) {
    return YES;
  }
  int fd = open_state_lock(@"stop-menu.lock");
  if (fd < 0) {
    return NO;
  }
  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    close(fd);
    return NO;
  }
  gStopMenuLock = fd;
  return YES;
}

static NSString *stop_menu_parents_dir(void) {
  return [stop_file_path().stringByDeletingLastPathComponent
      stringByAppendingPathComponent:@"stop-menu-parents"];
}

// Start time in microseconds, so a pid reused by another process never counts
// as the server that registered it. Zero when the process is gone.
static uint64_t process_start(pid_t pid) {
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) !=
      (int)sizeof(info)) {
    return 0;
  }
  return (uint64_t)info.pbi_start_tvsec * 1000000ULL + info.pbi_start_tvusec;
}

static void register_stop_menu_parent(pid_t pid) {
  uint64_t start = process_start(pid);
  if (start == 0) {
    return;
  }
  NSString *dir = stop_menu_parents_dir();
  [NSFileManager.defaultManager createDirectoryAtPath:dir
                          withIntermediateDirectories:YES
                                           attributes:nil
                                                error:nil];
  NSString *name =
      [NSString stringWithFormat:@"%d-%llu", pid, (unsigned long long)start];
  [NSData.data writeToFile:[dir stringByAppendingPathComponent:name]
                atomically:NO];
}

// Whether any server that started a status helper still runs; forgets the
// servers that exited.
static BOOL stop_menu_parent_alive(void) {
  NSString *dir = stop_menu_parents_dir();
  BOOL alive = NO;
  for (NSString *name in
       [NSFileManager.defaultManager contentsOfDirectoryAtPath:dir
                                                         error:NULL]) {
    int pid = 0;
    unsigned long long start = 0;
    if (sscanf(name.UTF8String, "%d-%llu", &pid, &start) == 2 && pid > 0 &&
        process_start(pid) == start) {
      alive = YES;
      continue;
    }
    [NSFileManager.defaultManager
        removeItemAtPath:[dir stringByAppendingPathComponent:name]
                   error:NULL];
  }
  return alive;
}

static BOOL history_menu_running(void) {
  int fd = open_state_lock(@"menubar-history.lock");
  if (fd < 0) {
    return NO;
  }
  BOOL held = flock(fd, LOCK_EX | LOCK_NB) != 0;
  close(fd);
  return held;
}

static BOOL stop_menu_visible(void) {
  return hold_stop_menu_lock() && !history_menu_running();
}

static void ensure_status_item(void);
static void remove_status_item(void);

static void refresh_stop_menu(void) {
  if (stop_menu_visible()) {
    ensure_status_item();
  } else {
    remove_status_item();
  }
}

static void update_status_item(void) {
  if (gStatusItem == nil) {
    return;
  }
  NSString *mode = gMode == 1   ? @"scroll"
                   : gMode == 2 ? @"thinking"
                   : gMode == 3 ? @"keyboard"
                                : @"pointer";
  NSString *label = [NSString
      stringWithFormat:@"opencua running, mode %@, motion %@", mode, gStyle];
  // Setting the button's image and title lays the menu bar item out again even
  // when nothing changed, so only a change is applied.
  NSString *shown = [NSString
      stringWithFormat:@"%@|%d|%d", label, stop_engaged(), gStatusOnly];
  if ([shown isEqualToString:gShownStatus]) {
    return;
  }
  gShownStatus = shown;
  NSStatusBarButton *button = gStatusItem.button;
  NSString *symbol = gMode == 3 ? @"keyboard" : @"cursorarrow";
  NSImage *image = [NSImage imageWithSystemSymbolName:symbol
                             accessibilityDescription:@"opencua running"];
  image.template = YES;
  button.image = image;
  button.title = @"opencua";
  button.toolTip = label;
  [button setAccessibilityLabel:label];
  BOOL stopped = stop_engaged();
  NSArray<NSString *> *lines = gStatusOnly ? status_only_lines(stopped) : @[
    @"opencua running",
    [@"Mode: " stringByAppendingString:mode],
    [@"Motion: " stringByAppendingString:gStyle],
  ];
  if (gStatusOnly) {
    NSString *state =
        stopped ? @"opencua: all agents stopped" : @"opencua: agents may act";
    NSImage *control = [NSImage
        imageWithSystemSymbolName:stopped ? @"stop.circle.fill" : @"stop.circle"
         accessibilityDescription:state];
    control.template = YES;
    button.image = control;
    button.title = stopped ? @"stopped" : @"";
    button.toolTip = state;
    [button setAccessibilityLabel:state];
  }
  NSMenu *menu = control_menu(gStatusItem.menu, lines, stopped);
  if (gStatusItem.menu != menu) {
    gStatusItem.menu = menu;
  }
}

static void ensure_status_item(void) {
  if (gStatusItem == nil) {
    gStatusItem = [[NSStatusBar systemStatusBar]
        statusItemWithLength:NSVariableStatusItemLength];
    gStatusItem.button.imagePosition = NSImageLeft;
  }
  update_status_item();
}

static void remove_status_item(void) {
  if (gStatusItem != nil) {
    [gStatusItem.menu cancelTracking];
    [[NSStatusBar systemStatusBar] removeStatusItem:gStatusItem];
    gStatusItem = nil;
    gShownStatus = nil;
  }
}

static void start_ripple(NSPoint windowOrigin);

static void start_marker_cue(OverlayPointerView *view) {
  [view.cueTimer invalidate];
  view.cueTimer = [NSTimer
      scheduledTimerWithTimeInterval:1.0 / kThemeFps
                             repeats:YES
                               block:^(NSTimer *timer) {
                                 view.pulse =
                                     fmod(view.pulse + 1.0 / (kThemeFps *
                                                              kCueLoopDuration),
                                          1.0);
                                 if (view.clickStart > 0.0 &&
                                     [NSDate timeIntervalSinceReferenceDate] -
                                             view.clickStart >=
                                         kClickDuration) {
                                   view.clickStart = 0.0;
                                 }
                                 if (view.keyPressStart > 0.0 &&
                                     [NSDate timeIntervalSinceReferenceDate] -
                                             view.keyPressStart >=
                                         kKeyPressDuration) {
                                   view.keyPressStart = 0.0;
                                 }
                                 [view setNeedsDisplay:YES];
                                 int mode =
                                     [gMarkerModes[view.markerKey] intValue];
                                 if (mode != 1 && mode != 2 &&
                                     view.clickStart == 0.0 &&
                                     view.keyPressStart == 0.0) {
                                   [timer invalidate];
                                   view.cueTimer = nil;
                                 }
                               }];
}

static void apply_mode(const char *name, NSNumber *markerKey) {
  if (markerKey != nil) {
    OverlayPointerView *view = (OverlayPointerView *)gMarkerViews[markerKey];
    if (strcmp(name, "keypress") == 0) {
      uint64_t generation = view.generation;
      double wait =
          fmax(0.0, view.arrival - [NSDate timeIntervalSinceReferenceDate]);
      dispatch_after(
          dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)),
          dispatch_get_main_queue(), ^{
            if (gMarkerViews[markerKey] == view &&
                view.generation == generation &&
                marker_window(markerKey, NO).isVisible) {
              view.keyPressStart = [NSDate timeIntervalSinceReferenceDate];
              view.generation++;
              start_marker_cue(view);
            }
          });
      return;
    }
    if (strncmp(name, "click", 5) == 0) {
      uint64_t generation = view.generation;
      double wait =
          fmax(0.0, view.arrival - [NSDate timeIntervalSinceReferenceDate]);
      dispatch_after(
          dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)),
          dispatch_get_main_queue(), ^{
            if (gMarkerViews[markerKey] == view &&
                view.generation == generation &&
                marker_window(markerKey, NO).isVisible) {
              view.clickStart = [NSDate timeIntervalSinceReferenceDate];
              view.generation++;
              start_marker_cue(view);
            }
          });
      return;
    }
    int markerMode = strncmp(name, "scroll", 6) == 0
                         ? 1
                         : (strncmp(name, "think", 5) == 0
                                ? 2
                                : (strncmp(name, "keyboard", 8) == 0
                                       ? 3
                                       : (strcmp(name, "drag") == 0 ? 4 : 0)));
    view.scrollDirection = strcmp(name, "scroll up") == 0      ? 1
                           : strcmp(name, "scroll down") == 0  ? 2
                           : strcmp(name, "scroll left") == 0  ? 3
                           : strcmp(name, "scroll right") == 0 ? 4
                                                               : 0;
    if (markerMode == 4 && !view.hasDragAnchor) {
      view.dragAnchor = marker_window(markerKey, NO).frame.origin;
      view.hasDragAnchor = YES;
    }
    if (markerMode != 4)
      view.hasDragAnchor = NO;
    gMarkerModes[markerKey] = @(markerMode);
    if (markerMode == 1 || markerMode == 2) {
      start_marker_cue(view);
    } else {
      [view.cueTimer invalidate];
      view.cueTimer = nil;
      view.pulse = 0.0;
      view.clickStart = 0.0;
    }
    [view setNeedsDisplay:YES];
    return;
  }
  // "click" is an event, not a mode: ripple at the tip where the cursor is
  // heading, once it arrives.
  if (strncmp(name, "click", 5) == 0) {
    NSWindow *window = marker_window(markerKey, NO);
    if (window == nil || (markerKey == nil && !gShown) ||
        (markerKey != nil && window.isVisible == NO)) {
      return;
    }
    NSPoint destination = gScootTimer != nil ? gScootTo : window.frame.origin;
    NSTimeInterval wait = gScootTimer != nil ? kScootDuration : 0.0;
    if (gTrajTimer != nil) {
      destination = gTrajToOrigin;
      wait = fmax(0.0, gTrajStart + gTrajArrival -
                           [NSDate timeIntervalSinceReferenceDate]);
    }
    uint64_t generation = gGeneration;
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
          if (generation == gGeneration) {
            start_ripple(destination);
          }
        });
    return;
  }
  if (strcmp(name, "keypress") == 0) {
    uint64_t generation = gGeneration;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 0),
                   dispatch_get_main_queue(), ^{
                     if (generation == gGeneration && gShown) {
                       gKeyPressStart = [NSDate timeIntervalSinceReferenceDate];
                       gGeneration++;
                       [gPointerView setNeedsDisplay:YES];
                     }
                   });
    return;
  }
  int mode = 0;
  if (strncmp(name, "scroll", 6) == 0) {
    mode = 1;
  } else if (strncmp(name, "think", 5) == 0) {
    mode = 2;
  } else if (strncmp(name, "keyboard", 8) == 0) {
    mode = 3;
  } else if (strcmp(name, "drag") == 0) {
    mode = 4;
    NSWindow *window = marker_window(markerKey, NO);
    gDragAnchor = window.frame.origin;
    gHasDragAnchor = window != nil;
  }
  if (mode == 4 && !gHasDragAnchor) {
    NSWindow *window = marker_window(markerKey, NO);
    gDragAnchor = window.frame.origin;
    gHasDragAnchor = window != nil;
  }
  if (mode != 4)
    gHasDragAnchor = NO;
  gScrollDirection = strcmp(name, "scroll up") == 0      ? 1
                     : strcmp(name, "scroll down") == 0  ? 2
                     : strcmp(name, "scroll left") == 0  ? 3
                     : strcmp(name, "scroll right") == 0 ? 4
                                                         : 0;
  gMode = mode;
  update_status_item();
  if (mode == 1 || mode == 2) {
    start_pulse();
  } else {
    stop_pulse();
  }
  // Only repaint/raise if the cursor is already positioned — a mode set before
  // the first `set` must NOT flash the cursor at (0,0); it applies once
  // positioned.
  NSWindow *window = marker_window(markerKey, NO);
  NSView *view = markerKey == nil ? gPointerView : gMarkerViews[markerKey];
  if (window != nil && (markerKey != nil || gShown)) {
    [window orderFrontRegardless];
    [view setNeedsDisplay:YES];
  }
}

// Cua Driver palette: session fill (the anonymous/default session's Cua blue),
// white ink, and the effect colour (fill lifted 45% toward white) used for the
// press ripple.
static NSColor *cua_fill(CGFloat alpha) {
  return [NSColor colorWithSRGBRed:94.0 / 255.0
                             green:192.0 / 255.0
                              blue:232.0 / 255.0
                             alpha:alpha];
}

static NSColor *cua_ink(CGFloat alpha) {
  return [NSColor colorWithSRGBRed:1.0 green:1.0 blue:1.0 alpha:alpha];
}

static NSColor *cursor_edge(CGFloat alpha) {
  return [NSColor colorWithSRGBRed:0.05 green:0.18 blue:0.26 alpha:alpha];
}

static NSColor *cua_effect(CGFloat alpha) {
  return [NSColor colorWithSRGBRed:167.0 / 255.0
                             green:220.0 / 255.0
                              blue:242.0 / 255.0
                             alpha:alpha];
}

// Piecewise keyframe track {frame, value}, smoothstepped between keys (Cua
// eases every key).
typedef struct {
  CGFloat frame;
  CGFloat value;
} Keyframe;

static CGFloat keyframe_value(const Keyframe *keys, int count, CGFloat frame) {
  if (frame <= keys[0].frame) {
    return keys[0].value;
  }
  for (int i = 1; i < count; i++) {
    if (frame <= keys[i].frame) {
      CGFloat t =
          (frame - keys[i - 1].frame) / (keys[i].frame - keys[i - 1].frame);
      t = t * t * (3.0 - 2.0 * t);
      return keys[i - 1].value + (keys[i].value - keys[i - 1].value) * t;
    }
  }
  return keys[count - 1].value;
}

static NSBezierPath *round_path(void) {
  NSBezierPath *path = [NSBezierPath bezierPath];
  path.lineJoinStyle = NSLineJoinStyleRound;
  path.lineCapStyle = NSLineCapStyleRound;
  return path;
}

// The arrow outline: Cua's CURSOR_PATH, rows of {vertex, in-tangent,
// out-tangent} (tangents relative).
static NSBezierPath *arrow_path(void) {
  static NSBezierPath *path = nil;
  if (path != nil) {
    return path;
  }
  static const CGFloat v[8][6] = {
      {55, 30, 0, 0, -7, -2}, {43, 41, -1, -8, 0, 0}, {64, 98, 0, 0, 3, 8},
      {77, 99, -4, 7, 0, 0},  {86, 79, 0, 0, 2, -4},  {95, 70, -4, 2, 0, 0},
      {108, 63, 0, 0, 7, -4}, {107, 50, 7, 3, 0, 0},
  };
  path = round_path();
  [path moveToPoint:NSMakePoint(v[0][0], v[0][1])];
  for (int i = 0; i < 8; i++) {
    int n = (i + 1) % 8;
    [path curveToPoint:NSMakePoint(v[n][0], v[n][1])
         controlPoint1:NSMakePoint(v[i][0] + v[i][4], v[i][1] + v[i][5])
         controlPoint2:NSMakePoint(v[n][0] + v[n][2], v[n][1] + v[n][3])];
  }
  [path closePath];
  return path;
}

static NSBezierPath *segments_path(const CGFloat (*points)[2], const int *runs,
                                   int runCount) {
  NSBezierPath *path = round_path();
  int index = 0;
  for (int r = 0; r < runCount; r++) {
    [path moveToPoint:NSMakePoint(points[index][0], points[index][1])];
    for (int i = 1; i < runs[r]; i++) {
      [path
          lineToPoint:NSMakePoint(points[index + i][0], points[index + i][1])];
    }
    index += runs[r];
  }
  return path;
}

// action_click: three short rays fanning out from the upper-left of the tip.
static NSBezierPath *click_rays_path(void) {
  static NSBezierPath *path = nil;
  if (path == nil) {
    static const CGFloat points[6][2] = {{35, 20}, {34, 11}, {27, 25},
                                         {19, 19}, {25, 34}, {15, 34}};
    static const int runs[3] = {2, 2, 2};
    path = segments_path(points, runs, 3);
  }
  return path;
}

// action_scroll: up and down chevrons to the left of the arrow.
static NSBezierPath *scroll_chevrons_path(void) {
  static NSBezierPath *path = nil;
  if (path == nil) {
    static const CGFloat points[6][2] = {{23, 31}, {31, 22}, {39, 31},
                                         {23, 49}, {31, 58}, {39, 49}};
    static const int runs[2] = {3, 3};
    path = segments_path(points, runs, 2);
  }
  return path;
}

// action_observe: two concentric "looking" arcs above-left of the tip.
static NSBezierPath *observe_arcs_path(void) {
  static NSBezierPath *path = nil;
  if (path == nil) {
    path = round_path();
    [path moveToPoint:NSMakePoint(38, 28)];
    [path curveToPoint:NSMakePoint(20, 49)
         controlPoint1:NSMakePoint(27, 29)
         controlPoint2:NSMakePoint(20, 38)];
    [path moveToPoint:NSMakePoint(42, 19)];
    [path curveToPoint:NSMakePoint(11, 51)
         controlPoint1:NSMakePoint(23, 19)
         controlPoint2:NSMakePoint(11, 33)];
  }
  return path;
}

static NSBezierPath *keyboard_path(void) {
  NSBezierPath *path = round_path();
  [path appendBezierPathWithRoundedRect:NSMakeRect(22, 46, 72, 42)
                                xRadius:7
                                yRadius:7];
  for (int row = 0; row < 2; row++) {
    int keys = row == 0 ? 7 : 6;
    CGFloat keyWidth = row == 0 ? 5 : 6;
    CGFloat gap = row == 0 ? 4 : 5;
    CGFloat start = row == 0 ? 29 : 31;
    for (int key = 0; key < keys; key++) {
      NSRect rect = NSMakeRect(start + key * (keyWidth + gap), 53 + row * 11,
                               keyWidth, 5);
      [path appendBezierPathWithRoundedRect:rect xRadius:1.5 yRadius:1.5];
    }
  }
  [path appendBezierPathWithRoundedRect:NSMakeRect(43, 76, 30, 5)
                                xRadius:1.5
                                yRadius:1.5];
  return path;
}

static void stroke_path(NSBezierPath *path, CGFloat width, NSColor *color) {
  [path setLineWidth:width];
  [color setStroke];
  [path stroke];
}

// cursor_layers: eight widening, fading Cua-blue glow strokes under a blue body
// with a white outline.
static void draw_arrow(CGFloat glowBoost) {
  static const CGFloat glow[8][2] = {{44, 2.0}, {36, 2.4}, {29, 3.0}, {23, 3.8},
                                     {18, 4.8}, {14, 6.0}, {10, 7.5}, {7, 9.5}};
  NSBezierPath *path = arrow_path();
  for (int i = 0; i < 8; i++) {
    stroke_path(path, glow[i][0],
                cua_fill(fmin(1.0, glow[i][1] / 100.0 * glowBoost)));
  }
  [cua_fill(1.0) setFill];
  [path fill];
  stroke_path(path, 9.0, cursor_edge(1.0));
  stroke_path(path, 5.0, cua_ink(1.0));
}

// cue_layers: a layer (anchor 64,64 placed at px,py, scaled) of glow strokes, a
// white outline, then a blue core.
static void draw_cue(CGContextRef ctx, NSBezierPath *geometry, CGFloat px,
                     CGFloat py, CGFloat scale, CGFloat alpha) {
  if (alpha <= 0.001) {
    return;
  }
  static const CGFloat glow[4][2] = {{13, 2.4}, {9, 3.1}, {6, 4.0}, {3, 5.2}};
  const CGFloat width = 4.0;
  CGContextSaveGState(ctx);
  CGContextTranslateCTM(ctx, px, py);
  CGContextScaleCTM(ctx, scale, scale);
  CGContextTranslateCTM(ctx, -64.0, -64.0);
  for (int i = 0; i < 4; i++) {
    stroke_path(geometry, width + glow[i][0],
                cua_fill(alpha * glow[i][1] / 100.0));
  }
  stroke_path(geometry, width + 3.5, cursor_edge(alpha));
  stroke_path(geometry, width + 1.5, cua_ink(alpha));
  stroke_path(geometry, width - 1.0, cua_fill(alpha));
  CGContextRestoreGState(ctx);
}

static NSBezierPath *drag_anchor_path(void) {
  NSBezierPath *path = round_path();
  [path moveToPoint:NSMakePoint(31, 23)];
  [path lineToPoint:NSMakePoint(38, 30)];
  [path lineToPoint:NSMakePoint(31, 37)];
  [path lineToPoint:NSMakePoint(24, 30)];
  [path closePath];
  return path;
}

@implementation OverlayPointerView
- (BOOL)isFlipped {
  return YES;
}
- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  CGContextRef ctx = NSGraphicsContext.currentContext.CGContext;
  CGContextSaveGState(ctx);
  // Theme canvas -> view: the canvas tip lands on the window hotspot.
  CGFloat artScale = kThemeDisplaySize / kThemeCanvas;
  CGContextTranslateCTM(ctx, kHotspotX, kHotspotY);
  CGContextScaleCTM(ctx, artScale, artScale);
  CGContextTranslateCTM(ctx, -kThemeTipX, -kThemeTipY);

  int mode =
      self.markerKey == nil ? gMode : [gMarkerModes[self.markerKey] intValue];
  NSInteger scrollDirection =
      self.markerKey == nil ? gScrollDirection : self.scrollDirection;
  BOOL clicking =
      self.markerKey == nil ? gRippleTimer != nil : self.clickStart > 0.0;
  double click = self.markerKey == nil
                     ? gRipple
                     : fmin(1.0, ([NSDate timeIntervalSinceReferenceDate] -
                                  self.clickStart) /
                                     kClickDuration);
  double pulse = self.markerKey == nil ? gPulse : self.pulse;
  CGFloat clickFrame = click * 20.0;
  CGFloat loopFrame = pulse * 48.0;
  CGFloat breathe = (mode == 2) ? (0.5 - 0.5 * cos(pulse * 2.0 * M_PI)) : 0.0;

  // Press squish (Cua: 100% -> 93% -> 103% -> 100%), pivoting on the tip so it
  // never leaves the target.
  static const Keyframe squish[4] = {
      {0, 1.0}, {7, 0.93}, {12, 1.03}, {20, 1.0}};
  CGFloat bodyScale = clicking ? keyframe_value(squish, 4, clickFrame) : 1.0;
  CGContextSaveGState(ctx);
  CGContextTranslateCTM(ctx, kThemeTipX, kThemeTipY);
  CGContextRotateCTM(ctx, (self.markerKey == nil ? gHeading : self.heading) -
                              M_PI_4);
  CGContextScaleCTM(ctx, bodyScale, bodyScale);
  CGContextTranslateCTM(ctx, -kThemeTipX, -kThemeTipY);
  draw_arrow(1.0 + 1.6 * breathe);
  CGContextRestoreGState(ctx);

  if (mode == 1) {
    static const Keyframe y[3] = {{0, 68}, {24, 60}, {48, 68}};
    static const Keyframe a[3] = {{0, 0.42}, {24, 1.0}, {48, 0.42}};
    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, 31, 40);
    if (scrollDirection == 2 || scrollDirection == 4)
      CGContextScaleCTM(ctx, -1, -1);
    if (scrollDirection == 3)
      CGContextRotateCTM(ctx, -M_PI_2);
    if (scrollDirection == 4)
      CGContextRotateCTM(ctx, M_PI_2);
    CGContextTranslateCTM(ctx, -31, -40);
    draw_cue(ctx, scroll_chevrons_path(), 59, keyframe_value(y, 3, loopFrame),
             1.0, keyframe_value(a, 3, loopFrame));
    CGContextRestoreGState(ctx);
  } else if (mode == 2) {
    static const Keyframe s[3] = {{0, 0.88}, {24, 1.0}, {48, 1.08}};
    static const Keyframe a[5] = {{0, 0}, {7, 1}, {34, 1}, {44, 0}, {48, 0}};
    draw_cue(ctx, observe_arcs_path(), 72, 54, keyframe_value(s, 3, loopFrame),
             keyframe_value(a, 5, loopFrame));
  } else if (mode == 3) {
    draw_cue(ctx, keyboard_path(), 150, 78, 0.75, 1.0);
    double keyAge =
        [NSDate timeIntervalSinceReferenceDate] -
        (self.markerKey == nil ? gKeyPressStart : self.keyPressStart);
    if (keyAge >= 0.0 && keyAge < kKeyPressDuration) {
      static const Keyframe flash[4] = {{0, 0}, {3, 1}, {5, 1}, {8, 0}};
      draw_cue(ctx, keyboard_path(), 150, 78, 0.82,
               keyframe_value(flash, 4, keyAge * 30.0));
    }
  } else if (mode == 4) {
    draw_cue(ctx, click_rays_path(), 74, 67, 1.0, 1.0);
    NSBezierPath *line = round_path();
    NSWindow *window = self.window;
    NSPoint anchor = self.markerKey == nil ? gDragAnchor : self.dragAnchor;
    BOOL hasAnchor =
        self.markerKey == nil ? gHasDragAnchor : self.hasDragAnchor;
    if (hasAnchor && window != nil) {
      CGFloat scale = kThemeDisplaySize / kThemeCanvas;
      NSPoint current = window.frame.origin;
      CGFloat ax = kHotspotX + (anchor.x - current.x) / scale;
      CGFloat ay = kOverlaySize - kHotspotY - (anchor.y - current.y) / scale;
      [line moveToPoint:NSMakePoint(ax, ay)];
      [line lineToPoint:NSMakePoint(kThemeTipX, kThemeTipY)];
      draw_cue(ctx, line, 0, 0, 1.0, 0.9);
      draw_cue(ctx, drag_anchor_path(), ax, ay, 1.0, 1.0);
    }
  }
  if (clicking) {
    static const Keyframe s[3] = {{0, 1.1}, {8, 1.3}, {20, 1.5}};
    static const Keyframe a[4] = {{0, 0}, {4, 1}, {11, 1}, {20, 0}};
    draw_cue(ctx, click_rays_path(), 74, 67, keyframe_value(s, 3, clickFrame),
             keyframe_value(a, 4, clickFrame));
  }
  CGContextRestoreGState(ctx);
}
@end

// Background markers never float above the user's work. Each one is stacked
// directly above the frontmost on-screen normal window of the app it drives, so
// any window the user brings in front of that app also covers its cursor, and a
// target with no on-screen window (hidden, minimized, another Space) hides it.
// `windows` is a front-to-back CGWindowListCopyWindowInfo result.
static CGWindowID marker_target_window(NSArray<NSDictionary *> *windows,
                                       pid_t pid) {
  if (pid <= 0) {
    return kCGNullWindowID;
  }
  for (NSDictionary *info in windows) {
    NSNumber *owner = info[(__bridge NSString *)kCGWindowOwnerPID];
    NSNumber *layer = info[(__bridge NSString *)kCGWindowLayer];
    NSNumber *number = info[(__bridge NSString *)kCGWindowNumber];
    if (![owner isKindOfClass:[NSNumber class]] ||
        ![layer isKindOfClass:[NSNumber class]] ||
        ![number isKindOfClass:[NSNumber class]]) {
      continue;
    }
    if (owner.intValue == pid && layer.intValue == 0 &&
        number.unsignedIntValue != kCGNullWindowID) {
      return (CGWindowID)number.unsignedIntValue;
    }
  }
  return kCGNullWindowID;
}

static void stack_marker_window(NSWindow *window, NSNumber *key,
                                NSArray<NSDictionary *> *windows) {
  if (window == nil || key == nil) {
    return;
  }
  CGWindowID target = marker_target_window(windows, (pid_t)key.intValue);
  if (target == kCGNullWindowID) {
    [window orderOut:nil];
    return;
  }
  [window setLevel:NSNormalWindowLevel];
  [window orderWindow:NSWindowAbove relativeTo:(NSInteger)target];
}

static NSArray<NSDictionary *> *onscreen_windows(void) {
  return CFBridgingRelease(CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID));
}

static void stack_marker(NSWindow *window, NSNumber *key) {
  stack_marker_window(window, key, onscreen_windows());
}

// The user can raise, hide or move the target app at any time; re-stack every
// marker and per-app highlight so each stays just above its own app.
static void restack_markers(void) {
  if (gMarkerWindows.count == 0 && gMarkerHighlights.count == 0) {
    return;
  }
  NSArray<NSDictionary *> *windows = onscreen_windows();
  for (NSNumber *key in gMarkerHighlights.allKeys) {
    stack_marker_window(gMarkerHighlights[key], key, windows);
  }
  for (NSNumber *key in gMarkerWindows.allKeys) {
    stack_marker_window(gMarkerWindows[key], key, windows);
  }
}

// AppKit marker objects are created and accessed only from the main queue.
static NSWindow *marker_window(NSNumber *key, BOOL create) {
  if (key == nil) {
    return gWindow;
  }
  NSWindow *window = gMarkerWindows[key];
  if (window != nil || !create) {
    return window;
  }
  NSRect frame = NSMakeRect(0, 0, kOverlaySize, kOverlaySize);
  window = [[NSWindow alloc] initWithContentRect:frame
                                       styleMask:NSWindowStyleMaskBorderless
                                         backing:NSBackingStoreBuffered
                                           defer:NO];
  [window setOpaque:NO];
  [window setBackgroundColor:[NSColor clearColor]];
  [window setHasShadow:NO];
  [window setIgnoresMouseEvents:YES];
  [window setLevel:NSNormalWindowLevel];
  [window setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces |
                                NSWindowCollectionBehaviorStationary |
                                NSWindowCollectionBehaviorIgnoresCycle |
                                NSWindowCollectionBehaviorFullScreenAuxiliary];
  OverlayPointerView *view = [[OverlayPointerView alloc] initWithFrame:frame];
  view.markerKey = key;
  view.heading = M_PI_4;
  [window setContentView:view];
  gMarkerWindows[key] = window;
  gMarkerViews[key] = view;
  return window;
}

// Press ripple: an expanding ring in the Cua effect colour, centred on the
// arrow tip.
@interface RippleView : NSView
@end

@implementation RippleView
- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  NSRect bounds = self.bounds;
  CGFloat progress = fmin(1.0, gRipple * 1.6);
  CGFloat eased = 1.0 - pow(1.0 - progress, 3.0);
  CGFloat radius = 4.0 + (NSWidth(bounds) / 2.0 - 6.0) * eased;
  NSRect ring = NSMakeRect(NSMidX(bounds) - radius, NSMidY(bounds) - radius,
                           radius * 2.0, radius * 2.0);
  NSBezierPath *path = [NSBezierPath bezierPathWithOvalInRect:ring];
  stroke_path(path, 2.5, cua_effect(0.95 * (1.0 - progress)));
}
@end

// Tip of the arrow, in Cocoa screen coordinates, for a pointer window at
// `windowOrigin`.
static NSPoint tip_for_origin(NSPoint windowOrigin) {
  return NSMakePoint(windowOrigin.x + kHotspotX,
                     windowOrigin.y + kOverlaySize - kHotspotY);
}

static void start_ripple(NSPoint windowOrigin) {
  if (gRippleWindow == nil) {
    return;
  }
  NSPoint tip = tip_for_origin(windowOrigin);
  [gRippleWindow setFrameOrigin:NSMakePoint(tip.x - kRippleSize / 2.0,
                                            tip.y - kRippleSize / 2.0)];
  [gRippleWindow orderFrontRegardless];
  // Keep the arrow above its own ripple.
  [gWindow orderFrontRegardless];
  if (gRippleTimer != nil) {
    [gRippleTimer invalidate];
    gRippleTimer = nil;
  }
  gRipple = 0.0;
  NSTimeInterval start = [NSDate timeIntervalSinceReferenceDate];
  gRippleTimer = [NSTimer
      scheduledTimerWithTimeInterval:1.0 / 60.0
                             repeats:YES
                               block:^(NSTimer *timer) {
                                 gRipple =
                                     ([NSDate timeIntervalSinceReferenceDate] -
                                      start) /
                                     kClickDuration;
                                 if (gRipple >= 1.0) {
                                   gRipple = 1.0;
                                   [gRippleWindow orderOut:nil];
                                   [timer invalidate];
                                   if (gRippleTimer == timer) {
                                     gRippleTimer = nil;
                                   }
                                   [gPointerView setNeedsDisplay:YES];
                                   return;
                                 }
                                 [gRippleWindow.contentView
                                     setNeedsDisplay:YES];
                                 [gPointerView setNeedsDisplay:YES];
                               }];
}

@interface HighlightView : NSView
@end

@implementation HighlightView
- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  NSRect inset = NSInsetRect(self.bounds, 3.0, 3.0);
  NSBezierPath *outline = [NSBezierPath bezierPathWithRoundedRect:inset
                                                          xRadius:12.0
                                                          yRadius:12.0];
  [outline setLineWidth:5.0];
  [[NSColor colorWithSRGBRed:0.39 green:0.78 blue:1.0 alpha:0.9] setStroke];
  [outline stroke];
}
@end

static CGFloat primary_screen_height(void) {
  NSArray<NSScreen *> *screens = [NSScreen screens];
  if (screens.count == 0) {
    return 0.0;
  }
  return NSHeight([screens[0] frame]);
}

static void apply_set(double x, double y) {
  NSWindow *window = gWindow;
  NSView *view = gPointerView;
  if (window == nil) {
    return;
  }
  gGeneration++;
  cancel_trajectory();
  gHeading = M_PI_4;
  gStyle = @"default";
  ensure_status_item();
  CGFloat screenHeight = primary_screen_height();
  // Cocoa window origins are bottom-left; the tip sits kHotspotY below the
  // window's top edge.
  NSPoint target =
      NSMakePoint(x - kHotspotX, screenHeight - y + kHotspotY - kOverlaySize);
  if (!gShown) {
    gShown = YES;
    [window setAlphaValue:0.0];
    [window setFrameOrigin:target];
    [window orderFrontRegardless];
    [NSAnimationContext
        runAnimationGroup:^(NSAnimationContext *context) {
          context.duration = kFadeInDuration;
          [[window animator] setAlphaValue:1.0];
        }
        completionHandler:nil];
    return;
  }
  [window orderFrontRegardless];
  if (gScootTimer != nil) {
    [gScootTimer invalidate];
    gScootTimer = nil;
  }
  gScootFrom = window.frame.origin;
  gScootTo = target;
  gScootStart = [NSDate timeIntervalSinceReferenceDate];
  gScootTimer = [NSTimer
      scheduledTimerWithTimeInterval:1.0 / 60.0
                             repeats:YES
                               block:^(NSTimer *timer) {
                                 double progress =
                                     ([NSDate timeIntervalSinceReferenceDate] -
                                      gScootStart) /
                                     kScootDuration;
                                 if (progress > 1.0) {
                                   progress = 1.0;
                                 }
                                 double eased =
                                     progress < 0.5
                                         ? 2.0 * progress * progress
                                         : 1.0 -
                                               pow(-2.0 * progress + 2.0, 2.0) /
                                                   2.0;
                                 [window setFrameOrigin:NSMakePoint(
                                                            gScootFrom.x +
                                                                (gScootTo.x -
                                                                 gScootFrom.x) *
                                                                    eased,
                                                            gScootFrom.y +
                                                                (gScootTo.y -
                                                                 gScootFrom.y) *
                                                                    eased)];
                                 if (progress >= 1.0) {
                                   [timer invalidate];
                                   if (gScootTimer == timer) {
                                     gScootTimer = nil;
                                   }
                                 }
                               }];
}

static void apply_marker_set(double x, double y, NSNumber *markerKey) {
  if (markerKey == nil) {
    return;
  }
  NSWindow *window = marker_window(markerKey, YES);
  if (window == nil || !isfinite(x) || !isfinite(y)) {
    return;
  }
  [gMarkerTimers[markerKey] invalidate];
  [gMarkerTimers removeObjectForKey:markerKey];
  OverlayPointerView *view = (OverlayPointerView *)gMarkerViews[markerKey];
  view.generation++;
  view.arrival = 0.0;
  view.clickStart = 0.0;
  CGFloat screenHeight = primary_screen_height();
  NSPoint target =
      NSMakePoint(x - kHotspotX, screenHeight - y + kHotspotY - kOverlaySize);
  [window setAlphaValue:1.0];
  [window setFrameOrigin:target];
  stack_marker(window, markerKey);
}

static void apply_direct_set(double x, double y) {
  NSWindow *window = gWindow;
  if (window == nil || !isfinite(x) || !isfinite(y)) {
    return;
  }
  CGFloat screenHeight = primary_screen_height();
  NSPoint target =
      NSMakePoint(x - kHotspotX, screenHeight - y + kHotspotY - kOverlaySize);
  gGeneration++;
  cancel_trajectory();
  if (gScootTimer != nil) {
    [gScootTimer invalidate];
    gScootTimer = nil;
  }
  [window setAlphaValue:1.0];
  [window setFrameOrigin:target];
  [window orderFrontRegardless];
  gShown = YES;
  ensure_status_item();
}

static void apply_highlight(double x, double y, double w, double h,
                            NSNumber *key) {
  if (w <= 0.0 || h <= 0.0) {
    return;
  }
  NSWindow *window = key == nil ? gHighlightWindow : gMarkerHighlights[key];
  if (window == nil && key != nil) {
    NSRect frame = NSMakeRect(0, 0, w, h);
    window = [[NSWindow alloc] initWithContentRect:frame
                                         styleMask:NSWindowStyleMaskBorderless
                                           backing:NSBackingStoreBuffered
                                             defer:NO];
    [window setOpaque:NO];
    [window setBackgroundColor:[NSColor clearColor]];
    [window setHasShadow:NO];
    [window setIgnoresMouseEvents:YES];
    [window setLevel:NSNormalWindowLevel];
    [window setCollectionBehavior:gHighlightWindow.collectionBehavior];
    [window setContentView:[[HighlightView alloc] initWithFrame:frame]];
    gMarkerHighlights[key] = window;
  }
  if (window == nil)
    return;
  if (key == nil)
    ensure_status_item();
  CGFloat screenHeight = primary_screen_height();
  [window setFrame:NSMakeRect(x, screenHeight - y - h, w, h) display:YES];
  [window.contentView setNeedsDisplay:YES];
  [window setAlphaValue:1.0];
  if (key == nil) {
    [window orderFrontRegardless];
  } else {
    stack_marker(window, key);
  }
  [(key == nil ? gHighlightTimer : gMarkerHighlightTimers[key]) invalidate];
  NSTimeInterval start = [NSDate timeIntervalSinceReferenceDate];
  NSTimer *fade = [NSTimer
      scheduledTimerWithTimeInterval:1.0 / 60.0
                             repeats:YES
                               block:^(NSTimer *timer) {
                                 double progress =
                                     ([NSDate timeIntervalSinceReferenceDate] -
                                      start) /
                                     0.5;
                                 if (progress >= 1.0) {
                                   [window setAlphaValue:0.0];
                                   [window orderOut:nil];
                                   [timer invalidate];
                                   if (key != nil) {
                                     [gMarkerHighlightTimers
                                         removeObjectForKey:key];
                                     [gMarkerHighlights removeObjectForKey:key];
                                   } else if (gHighlightTimer == timer) {
                                     gHighlightTimer = nil;
                                   }
                                   return;
                                 }
                                 [window setAlphaValue:1.0 - progress];
                               }];
  if (key == nil)
    gHighlightTimer = fade;
  else
    gMarkerHighlightTimers[key] = fade;
}

static void apply_hide(NSNumber *markerKey) {
  if (markerKey != nil) {
    OverlayPointerView *view = (OverlayPointerView *)gMarkerViews[markerKey];
    view.generation++;
    [view.cueTimer invalidate];
    view.cueTimer = nil;
    [gMarkerHighlightTimers[markerKey] invalidate];
    [gMarkerHighlightTimers removeObjectForKey:markerKey];
    [gMarkerHighlights[markerKey] orderOut:nil];
    [gMarkerHighlights removeObjectForKey:markerKey];
    [gMarkerTimers[markerKey] invalidate];
    [gMarkerTimers removeObjectForKey:markerKey];
    NSWindow *window = marker_window(markerKey, NO);
    [window orderOut:nil];
    [gMarkerWindows removeObjectForKey:markerKey];
    [gMarkerViews removeObjectForKey:markerKey];
    [gMarkerModes removeObjectForKey:markerKey];
    return;
  }
  gGeneration++;
  cancel_trajectory();
  if (gScootTimer != nil) {
    [gScootTimer invalidate];
    gScootTimer = nil;
  }
  stop_pulse();
  gMode = 0;
  gHeading = M_PI_4;
  if (gRippleTimer != nil) {
    [gRippleTimer invalidate];
    gRippleTimer = nil;
  }
  gRipple = 0.0;
  [gRippleWindow orderOut:nil];
  if (gHighlightTimer != nil) {
    [gHighlightTimer invalidate];
    gHighlightTimer = nil;
  }
  [gHighlightWindow setAlphaValue:0.0];
  [gHighlightWindow orderOut:nil];
  if (gWindow != nil) {
    [gWindow orderOut:nil];
    gShown = NO;
  }
  remove_status_item();
}

static NSPoint origin_for_point(double x, double y) {
  return NSMakePoint(x - kHotspotX,
                     primary_screen_height() - y + kHotspotY - kOverlaySize);
}

// Each app marker owns its playback; a direct sample or hide cancels only that
// lane.
static void play_marker_trajectory(double *samples, size_t count,
                                   double arrival, NSNumber *key) {
  NSData *data = [NSData dataWithBytesNoCopy:samples
                                      length:count * 4 * sizeof(double)
                                freeWhenDone:YES];
  apply_marker_set(samples[1], samples[2], key);
  NSWindow *window = marker_window(key, NO);
  OverlayPointerView *view = (OverlayPointerView *)gMarkerViews[key];
  view.heading = samples[3];
  [view setNeedsDisplay:YES];
  NSTimeInterval start = [NSDate timeIntervalSinceReferenceDate];
  view.arrival = start + arrival;
  NSTimer *timer = [NSTimer
      timerWithTimeInterval:1.0 / 60.0
                    repeats:YES
                      block:^(NSTimer *tick) {
                        const double *s = data.bytes;
                        double elapsed =
                            [NSDate timeIntervalSinceReferenceDate] - start;
                        BOOL done = elapsed >= s[(count - 1) * 4];
                        size_t i = count - 1;
                        double x = s[i * 4 + 1];
                        double y = s[i * 4 + 2];
                        double heading = s[i * 4 + 3];
                        if (!done) {
                          i = 0;
                          while (i + 2 < count && s[(i + 1) * 4] <= elapsed)
                            i++;
                          const double *a = s + i * 4;
                          const double *b = a + 4;
                          double u = (elapsed - a[0]) / (b[0] - a[0]);
                          x = a[1] + (b[1] - a[1]) * u;
                          y = a[2] + (b[2] - a[2]) * u;
                          heading =
                              a[3] + remainder(b[3] - a[3], 2.0 * M_PI) * u;
                        }
                        [window setFrameOrigin:origin_for_point(x, y)];
                        view.heading = heading;
                        [view setNeedsDisplay:YES];
                        if (done) {
                          [tick invalidate];
                          [gMarkerTimers removeObjectForKey:key];
                        }
                      }];
  gMarkerTimers[key] = timer;
  [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSRunLoopCommonModes];
}

// Take ownership of samples (count * {t, x, y, heading}) and play them back.
static void play_trajectory(double *samples, size_t count, double arrival,
                            NSString *style) {
  NSWindow *window = gWindow;
  NSView *view = gPointerView;
  if (window == nil) {
    free(samples);
    return;
  }
  const double *last = samples + (count - 1) * 4;
  if (!gShown) {
    // First move: appear at the target, nothing to travel from.
    apply_set(last[1], last[2]);
    gHeading = last[3];
    gStyle = style;
    update_status_item();
    free(samples);
    return;
  }
  gGeneration++;
  cancel_trajectory();
  if (gScootTimer != nil) {
    [gScootTimer invalidate];
    gScootTimer = nil;
  }
  gStyle = style;
  ensure_status_item();
  [gWindow orderFrontRegardless];
  gTrajSamples = samples;
  gTrajCount = count;
  gTrajStart = [NSDate timeIntervalSinceReferenceDate];
  gTrajArrival = arrival;
  gTrajToOrigin = origin_for_point(last[1], last[2]);
  uint64_t generation = gGeneration;
  NSTimer *timer = [NSTimer
      timerWithTimeInterval:1.0 / 60.0
                    repeats:YES
                      block:^(NSTimer *tick) {
                        if (generation != gGeneration || gTrajSamples == NULL) {
                          [tick invalidate];
                          return;
                        }
                        double elapsed =
                            [NSDate timeIntervalSinceReferenceDate] -
                            gTrajStart;
                        const double *s = gTrajSamples;
                        size_t n = gTrajCount;
                        BOOL done = elapsed >= s[(n - 1) * 4];
                        double x;
                        double y;
                        double h;
                        if (done) {
                          x = s[(n - 1) * 4 + 1];
                          y = s[(n - 1) * 4 + 2];
                          h = s[(n - 1) * 4 + 3];
                        } else {
                          size_t i = 0;
                          while (i + 2 < n && s[(i + 1) * 4] <= elapsed) {
                            i++;
                          }
                          const double *a = s + i * 4;
                          const double *b = a + 4;
                          double u = (elapsed - a[0]) / (b[0] - a[0]);
                          x = a[1] + (b[1] - a[1]) * u;
                          y = a[2] + (b[2] - a[2]) * u;
                          h = a[3] + remainder(b[3] - a[3], 2.0 * M_PI) * u;
                        }
                        [window setFrameOrigin:origin_for_point(x, y)];
                        gHeading = h;
                        [view setNeedsDisplay:YES];
                        if (done) {
                          [tick invalidate];
                          if (gTrajTimer == tick) {
                            gTrajTimer = nil;
                          }
                          free(gTrajSamples);
                          gTrajSamples = NULL;
                          gTrajCount = 0;
                        }
                      }];
  gTrajTimer = timer;
  [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSRunLoopCommonModes];
  update_status_item();
}

static void write_all(int fd, const char *bytes, size_t length) {
  while (length > 0) {
    ssize_t n = write(fd, bytes, length);
    if (n < 0 && errno == EINTR) {
      continue;
    }
    if (n <= 0) {
      return;
    }
    bytes += n;
    length -= (size_t)n;
  }
}

// Reply with the hotspot actually drawn now, in global top-left points. Pure
// query: shows nothing and leaves the idle timer alone.
static void write_state(int fd, NSNumber *markerKey) {
  double x = 0.0;
  double y = 0.0;
  NSWindow *window = marker_window(markerKey, NO);
  BOOL visible = window != nil && window.isVisible;
  BOOL shown = markerKey == nil ? gShown : visible;
  int mode = markerKey == nil ? gMode : [gMarkerModes[markerKey] intValue];
  NSInteger direction =
      markerKey == nil
          ? gScrollDirection
          : ((OverlayPointerView *)gMarkerViews[markerKey]).scrollDirection;
  const char *modeName = mode == 1   ? "scroll"
                         : mode == 2 ? "thinking"
                         : mode == 3 ? "keyboard"
                         : mode == 4 ? "drag"
                                     : "pointer";
  const char *directionName = direction == 1   ? "up"
                              : direction == 2 ? "down"
                              : direction == 3 ? "left"
                              : direction == 4 ? "right"
                                               : "";
  if (window != nil) {
    NSPoint origin = window.frame.origin;
    x = origin.x + kHotspotX;
    y = primary_screen_height() - (origin.y + kOverlaySize - kHotspotY);
  }
  BOOL reduced =
      [[NSWorkspace sharedWorkspace] accessibilityDisplayShouldReduceMotion];
  char out[320];
  int length = snprintf(
      out, sizeof(out),
      "{\"x\":%.6f,\"y\":%.6f,\"shown\":%s,\"visible\":%s,"
      "\"mode\":\"%s\",\"scrollDirection\":\"%s\",\"reducedMotion\":%s}\n",
      x, y, shown ? "true" : "false", visible ? "true" : "false", modeName,
      directionName, reduced ? "true" : "false");
  if (length > 0) {
    write_all(fd, out, (size_t)length);
  }
}

static BOOL json_number(id value, double *out) {
  if (![value isKindOfClass:[NSNumber class]] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
    return NO;
  }
  double number = [value doubleValue];
  if (!isfinite(number)) {
    return NO;
  }
  *out = number;
  return YES;
}

// Validate a whole trajectory payload before anything touches the UI. Returns
// malloc'd samples (count * 4 doubles) or NULL.
static double *parse_trajectory(const char *json, size_t *countOut,
                                double *arrivalOut,
                                NSString *__strong *styleOut) {
  static const size_t kMaxSamples = 4096;
  static const double kMaxCoordinate = 1000000.0;
  static const double kMaxDuration = 30.0;
  @autoreleasepool {
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    id root = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![root isKindOfClass:[NSDictionary class]]) {
      return NULL;
    }
    NSDictionary *object = root;
    NSSet *keys = [NSSet setWithArray:object.allKeys];
    if (![keys isEqualToSet:[NSSet setWithObjects:@"style", @"arrival",
                                                  @"samples", nil]]) {
      return NULL;
    }
    NSArray<NSString *> *known = @[
      @"signature_arc", @"spring_settle", @"magnetic", @"comet_swoop",
      @"adaptive", @"classic"
    ];
    id style = object[@"style"];
    if (![style isKindOfClass:[NSString class]] ||
        ![known containsObject:style]) {
      return NULL;
    }
    double arrival = 0.0;
    id samples = object[@"samples"];
    if (!json_number(object[@"arrival"], &arrival) || arrival < 0.0 ||
        ![samples isKindOfClass:[NSArray class]]) {
      return NULL;
    }
    NSArray *rows = samples;
    if (rows.count == 0 || rows.count > kMaxSamples) {
      return NULL;
    }
    double *out = malloc(rows.count * 4 * sizeof(double));
    if (out == NULL) {
      return NULL;
    }
    for (NSUInteger i = 0; i < rows.count; i++) {
      id row = rows[i];
      double *d = out + i * 4;
      if (![row isKindOfClass:[NSArray class]] || [row count] != 4 ||
          !json_number(row[0], &d[0]) || !json_number(row[1], &d[1]) ||
          !json_number(row[2], &d[2]) || !json_number(row[3], &d[3]) ||
          fabs(d[1]) > kMaxCoordinate || fabs(d[2]) > kMaxCoordinate ||
          fabs(d[3]) > kMaxCoordinate || d[0] < 0.0 || d[0] > kMaxDuration ||
          (i == 0 && d[0] != 0.0) || (i > 0 && d[0] <= d[-4])) {
        free(out);
        return NULL;
      }
    }
    if (arrival > out[(rows.count - 1) * 4]) {
      free(out);
      return NULL;
    }
    *countOut = rows.count;
    *arrivalOut = arrival;
    *styleOut = style;
    return out;
  }
}

// Parse one command line and apply it on the main thread. Returns 1 for "quit".
// Every recognized command resets the idle timer (daemon mode only).
static int dispatch_command_line(const char *line, int replyFd) {
  double x = 0.0;
  double y = 0.0;
  double w = 0.0;
  double h = 0.0;
  // sscanf accepts "nan" and "inf"; a non-finite frame makes Core Animation
  // throw and would end the overlay, so such lines are dropped like any other
  // malformed command.
  const char *command = line;
  NSNumber *key = nil;
  if (strncmp(command, "pid ", 4) == 0) {
    char *end = NULL;
    unsigned long long pid = strtoull(command + 4, &end, 10);
    if (end == command + 4 || *end != ' ') {
      return 0;
    }
    key = @(pid);
    command = end + 1;
  }
  if (strncmp(command, "trajectory ", 11) == 0) {
    size_t count = 0;
    double arrival = 0.0;
    NSString *style = nil;
    double *samples = parse_trajectory(command + 11, &count, &arrival, &style);
    if (samples == NULL) {
      return 0;
    }
    NSNumber *markerKey = key;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (markerKey != nil) {
        play_marker_trajectory(samples, count, arrival, markerKey);
      } else {
        play_trajectory(samples, count, arrival, style);
      }
      reset_idle_timer();
    });
  } else if (strncmp(command, "state", 5) == 0 &&
             (command[5] == '\0' || isspace((unsigned char)command[5]))) {
    // Answered on the main queue, in order after earlier commands; the
    // reader waits so the reply fd cannot be closed underneath it.
    dispatch_semaphore_t answered = dispatch_semaphore_create(0);
    NSNumber *markerKey = key;
    dispatch_async(dispatch_get_main_queue(), ^{
      write_state(replyFd, markerKey);
      dispatch_semaphore_signal(answered);
    });
    dispatch_semaphore_wait(answered, DISPATCH_TIME_FOREVER);
  } else if (sscanf(command, "track %lf %lf", &x, &y) == 2) {
    if (!isfinite(x) || !isfinite(y)) {
      return 0;
    }
    NSNumber *markerKey = key;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (markerKey != nil) {
        apply_marker_set(x, y, markerKey);
      } else {
        apply_direct_set(x, y);
      }
      reset_idle_timer();
    });
  } else if (sscanf(command, "set %lf %lf", &x, &y) == 2) {
    if (!isfinite(x) || !isfinite(y)) {
      return 0;
    }
    NSNumber *markerKey = key;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (markerKey != nil) {
        apply_marker_set(x, y, markerKey);
      } else {
        apply_set(x, y);
      }
      reset_idle_timer();
    });
  } else if (sscanf(command, "set-direct %lf %lf", &x, &y) == 2) {
    if (!isfinite(x) || !isfinite(y)) {
      return 0;
    }
    NSNumber *markerKey = key;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (markerKey != nil) {
        apply_marker_set(x, y, markerKey);
      } else {
        apply_direct_set(x, y);
      }
      reset_idle_timer();
    });
  } else if (sscanf(command, "highlight %lf %lf %lf %lf", &x, &y, &w, &h) ==
             4) {
    if (!isfinite(x) || !isfinite(y) || !isfinite(w) || !isfinite(h)) {
      return 0;
    }
    NSNumber *markerKey = key;
    dispatch_async(dispatch_get_main_queue(), ^{
      apply_highlight(x, y, w, h, markerKey);
      reset_idle_timer();
    });
  } else if (strncmp(command, "hide", 4) == 0) {
    NSNumber *markerKey = key;
    dispatch_async(dispatch_get_main_queue(), ^{
      apply_hide(markerKey);
      reset_idle_timer();
    });
  } else if (strncmp(command, "mode ", 5) == 0) {
    char name[32] = {0};
    char direction[16] = {0};
    char trailing[2] = {0};
    int fields =
        sscanf(command, "mode %31s %15s %1s", name, direction, trailing);
    BOOL valid = strcmp(name, "pointer") == 0 || strcmp(name, "scroll") == 0 ||
                 strcmp(name, "thinking") == 0 ||
                 strcmp(name, "keyboard") == 0 || strcmp(name, "click") == 0 ||
                 strcmp(name, "drag") == 0 || strcmp(name, "keypress") == 0;
    if (valid &&
        ((strcmp(name, "scroll") == 0 && fields == 2 && trailing[0] == '\0' &&
          (strcmp(direction, "up") == 0 || strcmp(direction, "down") == 0 ||
           strcmp(direction, "left") == 0 ||
           strcmp(direction, "right") == 0)) ||
         (strcmp(name, "scroll") == 0 && fields == 1) ||
         (strcmp(name, "scroll") != 0 && fields == 1 && trailing[0] == '\0'))) {
      if (strcmp(name, "scroll") == 0 && fields == 2) {
        strlcat(name, " ", sizeof(name));
        strlcat(name, direction, sizeof(name));
      }
      char *copy = strdup(name);
      NSNumber *markerKey = key;
      dispatch_async(dispatch_get_main_queue(), ^{
        if (markerKey != nil) {
          marker_window(markerKey, YES);
        }
        apply_mode(copy, markerKey);
        free(copy);
        reset_idle_timer();
      });
    }
  } else if (strncmp(command, "quit", 4) == 0) {
    return 1;
  }
  return 0;
}

// A command line grows on the heap up to kMaxLine bytes. A longer line is
// discarded whole, through its newline, so no fragment is ever executed.
static const size_t kMaxLine = 512 * 1024;

typedef struct {
  char *data;
  size_t length;
  size_t capacity;
  BOOL discarding;
} LineBuffer;

// Feed bytes through the line splitter, applying each complete command.
// Returns 1 if a "quit" was seen.
static int linebuf_feed(LineBuffer *lb, const char *buf, ssize_t n,
                        int replyFd) {
  for (ssize_t i = 0; i < n; i++) {
    char c = buf[i];
    if (c == '\n') {
      int quit = 0;
      if (!lb->discarding && lb->length > 0) {
        lb->data[lb->length] = '\0';
        quit = dispatch_command_line(lb->data, replyFd);
      }
      lb->length = 0;
      lb->discarding = NO;
      if (quit) {
        return 1;
      }
    } else if (lb->discarding) {
      continue;
    } else if (lb->length >= kMaxLine) {
      lb->discarding = YES;
      lb->length = 0;
    } else {
      if (lb->length + 1 >= lb->capacity) {
        size_t grown = lb->capacity == 0 ? 1024 : lb->capacity * 2;
        if (grown > kMaxLine + 1) {
          grown = kMaxLine + 1;
        }
        char *bigger = realloc(lb->data, grown);
        if (bigger == NULL) {
          lb->discarding = YES;
          lb->length = 0;
          continue;
        }
        lb->data = bigger;
        lb->capacity = grown;
      }
      lb->data[lb->length++] = c;
    }
  }
  return 0;
}

// Legacy mode: one command channel over stdin (state replies go to stdout),
// dies when stdin closes.
static void *stdin_reader(void *arg) {
  (void)arg;
  char buf[4096];
  LineBuffer lb = {0};
  ssize_t n;
  int quit = 0;
  while (!quit && (n = read(STDIN_FILENO, buf, sizeof(buf))) > 0) {
    quit = linebuf_feed(&lb, buf, n, STDOUT_FILENO);
  }
  if (!quit) {
    linebuf_feed(&lb, "\n", 1, STDOUT_FILENO); // final unterminated line
  }
  free(lb.data);
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSApp terminate:nil];
  });
  return NULL;
}

// Persistent daemon mode: a unix-domain socket server so the overlay outlives
// any single CLI command (each opencua verb is its own process). Singleton:
// if a daemon already owns the socket, exit. Self-terminates after idle
// timeout.
static void *socket_reader(void *arg) {
  char *path = (char *)arg;
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

  // If another daemon already listens here, stand down (singleton).
  int probe = socket(AF_UNIX, SOCK_STREAM, 0);
  if (probe >= 0) {
    if (connect(probe, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
      close(probe);
      free(path);
      dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp terminate:nil];
      });
      return NULL;
    }
    close(probe);
  }
  unlink(path); // clear any stale socket file from a crashed daemon

  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server < 0 || bind(server, (struct sockaddr *)&addr, sizeof(addr)) != 0 ||
      listen(server, 8) != 0) {
    if (server >= 0) {
      close(server);
    }
    free(path);
    dispatch_async(dispatch_get_main_queue(), ^{
      [NSApp terminate:nil];
    });
    return NULL;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    reset_idle_timer();
  });

  int stop = 0;
  while (!stop) {
    int client = accept(server, NULL, NULL);
    if (client < 0) {
      if (errno == EINTR) {
        continue;
      }
      break;
    }
    int one = 1;
    setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
    char buf[4096];
    LineBuffer lb = {0};
    ssize_t n;
    while ((n = read(client, buf, sizeof(buf))) > 0) {
      if (linebuf_feed(&lb, buf, n, client)) {
        stop = 1;
        break;
      }
    }
    free(lb.data);
    close(client);
  }
  close(server);
  unlink(path);
  free(path);
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSApp terminate:nil];
  });
  return NULL;
}

int main(int argc, const char *argv[]) {
  const char *socketPath = NULL;
  pid_t parent = 0;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) {
      socketPath = argv[++i];
    } else if (strcmp(argv[i], "--idle") == 0 && i + 1 < argc) {
      gIdleTimeout = atof(argv[++i]);
    } else if (strcmp(argv[i], "--status-only") == 0) {
      gStatusOnly = YES;
    } else if (strcmp(argv[i], "--parent") == 0 && i + 1 < argc) {
      parent = (pid_t)strtol(argv[++i], NULL, 10);
    }
  }
  signal(SIGPIPE, SIG_IGN);
  if (gStatusOnly) {
    if (parent > 0) {
      register_stop_menu_parent(parent);
    }
    // The helper that holds the lock now also watches this server.
    if (!hold_stop_menu_lock()) {
      return 0;
    }
  }
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    if (gStatusOnly) {
      // Lives while any opencua server that started a helper runs, and
      // mirrors stops made by the chord or `opencua stop` within a second.
      // Before exiting it lets go of the lock and looks again, so a server
      // that registered meanwhile either is seen here or takes the lock.
      refresh_stop_menu();
      [NSTimer scheduledTimerWithTimeInterval:1.0
                                      repeats:YES
                                        block:^(NSTimer *timer) {
                                          (void)timer;
                                          if (!stop_menu_parent_alive()) {
                                            close(gStopMenuLock);
                                            gStopMenuLock = -1;
                                            if (!stop_menu_parent_alive() ||
                                                !hold_stop_menu_lock()) {
                                              [NSApp terminate:nil];
                                              return;
                                            }
                                          }
                                          refresh_stop_menu();
                                        }];
      [NSApp run];
      return 0;
    }
    gMarkerWindows = [NSMutableDictionary dictionary];
    gMarkerViews = [NSMutableDictionary dictionary];
    gMarkerModes = [NSMutableDictionary dictionary];
    gMarkerTimers = [NSMutableDictionary dictionary];
    gMarkerHighlights = [NSMutableDictionary dictionary];
    gMarkerHighlightTimers = [NSMutableDictionary dictionary];

    NSRect frame = NSMakeRect(0, 0, kOverlaySize, kOverlaySize);
    gWindow = [[NSWindow alloc] initWithContentRect:frame
                                          styleMask:NSWindowStyleMaskBorderless
                                            backing:NSBackingStoreBuffered
                                              defer:NO];
    [gWindow setOpaque:NO];
    [gWindow setBackgroundColor:[NSColor clearColor]];
    [gWindow setHasShadow:NO];
    [gWindow setIgnoresMouseEvents:YES];
    // Stay above notification banners while remaining a non-interactive,
    // non-activating overlay.
    [gWindow setLevel:NSStatusWindowLevel];
    [gWindow
        setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces |
                              NSWindowCollectionBehaviorStationary |
                              NSWindowCollectionBehaviorIgnoresCycle |
                              NSWindowCollectionBehaviorFullScreenAuxiliary];
    gPointerView = [[OverlayPointerView alloc] initWithFrame:frame];
    [gWindow setContentView:gPointerView];

    gHighlightWindow =
        [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
                                    styleMask:NSWindowStyleMaskBorderless
                                      backing:NSBackingStoreBuffered
                                        defer:NO];
    [gHighlightWindow setOpaque:NO];
    [gHighlightWindow setBackgroundColor:[NSColor clearColor]];
    [gHighlightWindow setHasShadow:NO];
    [gHighlightWindow setIgnoresMouseEvents:YES];
    [gHighlightWindow setLevel:NSFloatingWindowLevel];
    [gHighlightWindow
        setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces |
                              NSWindowCollectionBehaviorStationary |
                              NSWindowCollectionBehaviorIgnoresCycle |
                              NSWindowCollectionBehaviorFullScreenAuxiliary];
    [gHighlightWindow
        setContentView:[[HighlightView alloc]
                           initWithFrame:NSMakeRect(0, 0, 100, 100)]];

    NSRect rippleFrame = NSMakeRect(0, 0, kRippleSize, kRippleSize);
    gRippleWindow =
        [[NSWindow alloc] initWithContentRect:rippleFrame
                                    styleMask:NSWindowStyleMaskBorderless
                                      backing:NSBackingStoreBuffered
                                        defer:NO];
    [gRippleWindow setOpaque:NO];
    [gRippleWindow setBackgroundColor:[NSColor clearColor]];
    [gRippleWindow setHasShadow:NO];
    [gRippleWindow setIgnoresMouseEvents:YES];
    [gRippleWindow setLevel:NSStatusWindowLevel];
    [gRippleWindow
        setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces |
                              NSWindowCollectionBehaviorStationary |
                              NSWindowCollectionBehaviorIgnoresCycle |
                              NSWindowCollectionBehaviorFullScreenAuxiliary];
    [gRippleWindow
        setContentView:[[RippleView alloc] initWithFrame:rippleFrame]];

    // Re-stack background markers when the user switches apps, and on a
    // light cadence for raises, minimizes and Space changes within an app.
    [[[NSWorkspace sharedWorkspace] notificationCenter]
        addObserverForName:NSWorkspaceDidActivateApplicationNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *note) {
                  (void)note;
                  restack_markers();
                }];
    [NSTimer scheduledTimerWithTimeInterval:0.25
                                    repeats:YES
                                      block:^(NSTimer *timer) {
                                        (void)timer;
                                        restack_markers();
                                      }];

    pthread_t thread;
    if (socketPath != NULL) {
      if (gIdleTimeout <= 0.0) {
        gIdleTimeout = 4.0; // default: vanish 4s after the last command
      }
      pthread_create(&thread, NULL, socket_reader, strdup(socketPath));
    } else {
      pthread_create(&thread, NULL, stdin_reader, NULL);
    }
    pthread_detach(thread);

    [NSApp run];
  }
  return 0;
}
