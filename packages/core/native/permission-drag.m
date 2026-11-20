// permission-drag: a small panel attached to the System Settings window that
// shows an app (its icon and name) for a person to drag into a Privacy &
// Security list: Accessibility, Screen & System Audio Recording or Input
// Monitoring. macOS can leave an ad-hoc signed helper out of those lists (after
// a rebuild its old entries vanish), and dropping the .app bundle on the list
// adds it, the same way the + button does.
//
//   permission-drag --app <path.app> [--title <text>] [--parent <pid>]
//
// The panel sits under the right-hand pane of System Settings with an arrow
// pointing up at the list (inside the window's lower edge when there is no
// room below it), follows the window when it moves, never takes focus, and
// hides while System Settings is not the frontmost app. It exits when its
// close button is pressed, on SIGTERM, SIGINT or SIGHUP, or when the --parent
// process exits.
#import <Cocoa/Cocoa.h>
#import <signal.h>
#import <stdlib.h>
#import <unistd.h>

static NSString *const kSettingsBundleId = @"com.apple.systempreferences";
static const CGFloat kPanelWidth = 340.0;
static const CGFloat kCardHeight = 76.0;
static const CGFloat kArrowHeight = 36.0;
static const CGFloat kIconSize = 52.0;
// Roughly the width of the System Settings sidebar; the privacy list is in the
// pane to its right.
static const CGFloat kSidebarWidth = 230.0;
// How far the arrow tip reaches into the window when the panel hangs below it.
static const CGFloat kArrowOverlap = 6.0;
static const NSTimeInterval kFollowInterval = 0.4;

static NSPanel *gPanel = nil;
static NSMutableArray *gSources = nil; // keeps dispatch sources alive

// The panel never becomes key or main, so System Settings keeps focus and the
// drag starts on the first click.
@interface AttachedPanel : NSPanel
@end

@implementation AttachedPanel
- (BOOL)canBecomeKeyWindow {
  return NO;
}
- (BOOL)canBecomeMainWindow {
  return NO;
}
@end

// The draggable area of the card: draws the app icon and starts a file drag of
// the app bundle's URL from anywhere on the card.
@interface AppDragView : NSView <NSDraggingSource>
@property(nonatomic, strong) NSURL *appURL;
@property(nonatomic, strong) NSImage *icon;
@property(nonatomic) NSRect iconRect;
@property(nonatomic) BOOL dragging;
@end

@implementation AppDragView
- (BOOL)acceptsFirstMouse:(NSEvent *)event {
  return YES;
}

- (void)resetCursorRects {
  [self addCursorRect:self.bounds cursor:NSCursor.openHandCursor];
}

- (void)drawRect:(NSRect)dirtyRect {
  [self.icon drawInRect:self.iconRect
               fromRect:NSZeroRect
              operation:NSCompositingOperationSourceOver
               fraction:1.0];
}

- (void)mouseDown:(NSEvent *)event {
  self.dragging = NO;
}

- (void)mouseDragged:(NSEvent *)event {
  if (self.dragging) {
    return;
  }
  self.dragging = YES;
  // NSURL writes public.file-url, the type Finder puts on the pasteboard when
  // an app is dragged out of a Finder window.
  NSDraggingItem *item =
      [[NSDraggingItem alloc] initWithPasteboardWriter:self.appURL];
  [item setDraggingFrame:self.iconRect contents:self.icon];
  [self beginDraggingSessionWithItems:@[ item ] event:event source:self];
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  return context == NSDraggingContextOutsideApplication
             ? (NSDragOperationCopy | NSDragOperationLink |
                NSDragOperationGeneric)
             : NSDragOperationNone;
}

- (void)draggingSession:(NSDraggingSession *)session
           endedAtPoint:(NSPoint)screenPoint
              operation:(NSDragOperation)operation {
  self.dragging = NO;
}
@end

// An arrow pointing up from the card at the list.
@interface ArrowView : NSView
@end

@implementation ArrowView
- (void)drawRect:(NSRect)dirtyRect {
  NSRect bounds = self.bounds;
  CGFloat midX = NSMidX(bounds);
  CGFloat head = 14.0;
  NSColor *color = NSColor.controlAccentColor;
  [color setStroke];
  [color setFill];

  NSBezierPath *shaft = [NSBezierPath bezierPath];
  shaft.lineWidth = 5.0;
  shaft.lineCapStyle = NSLineCapStyleRound;
  [shaft moveToPoint:NSMakePoint(midX, NSMinY(bounds) + 4.0)];
  [shaft lineToPoint:NSMakePoint(midX, NSMaxY(bounds) - head)];
  [shaft stroke];

  NSBezierPath *tip = [NSBezierPath bezierPath];
  [tip moveToPoint:NSMakePoint(midX, NSMaxY(bounds))];
  [tip lineToPoint:NSMakePoint(midX - head, NSMaxY(bounds) - head - 2.0)];
  [tip lineToPoint:NSMakePoint(midX + head, NSMaxY(bounds) - head - 2.0)];
  [tip closePath];
  [tip fill];
}
@end

@interface CloseTarget : NSObject
- (void)close:(id)sender;
@end

@implementation CloseTarget
- (void)close:(id)sender {
  exit(0);
}
@end

static CloseTarget *gCloseTarget = nil;

static void usage(void) {
  fprintf(stderr, "usage: permission-drag --app <path.app> [--title <text>] "
                  "[--parent <pid>]\n");
}

// The frontmost on-screen window of System Settings in Cocoa screen
// coordinates (origin at the bottom left of the primary display).
static BOOL settingsWindowFrame(pid_t pid, NSRect *frame) {
  CFArrayRef windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (windows == NULL) {
    return NO;
  }
  BOOL found = NO;
  NSArray *list = CFBridgingRelease(windows);
  for (NSDictionary *window in list) {
    if ([window[(id)kCGWindowOwnerPID] intValue] != pid ||
        [window[(id)kCGWindowLayer] intValue] != 0) {
      continue;
    }
    CGRect bounds;
    if (!CGRectMakeWithDictionaryRepresentation(
            (__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds) ||
        bounds.size.width < 300.0 || bounds.size.height < 200.0) {
      continue;
    }
    // The list is ordered front to back: the first match is the front window.
    CGFloat primaryHeight = NSScreen.screens.firstObject.frame.size.height;
    *frame = NSMakeRect(bounds.origin.x,
                        primaryHeight - bounds.origin.y - bounds.size.height,
                        bounds.size.width, bounds.size.height);
    found = YES;
    break;
  }
  return found;
}

static NSScreen *screenContaining(NSRect rect) {
  NSPoint center = NSMakePoint(NSMidX(rect), NSMidY(rect));
  for (NSScreen *screen in NSScreen.screens) {
    if (NSPointInRect(center, screen.frame)) {
      return screen;
    }
  }
  return NSScreen.mainScreen;
}

// Shows the panel under the list of the System Settings window while System
// Settings is the frontmost app, and hides it otherwise.
static void follow(void) {
  NSRunningApplication *settings =
      [NSRunningApplication
          runningApplicationsWithBundleIdentifier:kSettingsBundleId]
          .firstObject;
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  NSRect window;
  if (settings == nil || front.processIdentifier != settings.processIdentifier ||
      !settingsWindowFrame(settings.processIdentifier, &window)) {
    [gPanel orderOut:nil];
    return;
  }
  NSRect visible = screenContaining(window).visibleFrame;
  CGFloat height = gPanel.frame.size.height;
  CGFloat paneLeft =
      NSMinX(window) + MIN(kSidebarWidth, window.size.width * 0.4);
  CGFloat x = (paneLeft + NSMaxX(window)) / 2.0 - kPanelWidth / 2.0;
  x = MAX(NSMinX(visible) + 8.0, MIN(x, NSMaxX(visible) - kPanelWidth - 8.0));
  // Hang below the window with the arrow tip just inside its lower edge; with
  // no room below, sit inside the window's lower edge, still pointing up.
  CGFloat y = NSMinY(window) + kArrowOverlap - height;
  if (y < NSMinY(visible)) {
    y = NSMinY(window) + 16.0;
  }
  NSRect target = NSMakeRect(round(x), round(y), kPanelWidth, height);
  if (!NSEqualRects(gPanel.frame, target)) {
    [gPanel setFrame:target display:YES];
  }
  if (!gPanel.visible) {
    [gPanel orderFrontRegardless];
  }
}

static void exitOn(dispatch_source_t source) {
  dispatch_source_set_event_handler(source, ^{
    exit(0);
  });
  dispatch_resume(source);
  [gSources addObject:source];
}

static NSPanel *makePanel(NSString *appPath, NSString *title) {
  CGFloat height = kCardHeight + kArrowHeight;
  NSPanel *panel = [[AttachedPanel alloc]
      initWithContentRect:NSMakeRect(0, 0, kPanelWidth, height)
                styleMask:NSWindowStyleMaskBorderless |
                          NSWindowStyleMaskNonactivatingPanel
                  backing:NSBackingStoreBuffered
                    defer:NO];
  panel.level = NSFloatingWindowLevel;
  panel.opaque = NO;
  panel.backgroundColor = NSColor.clearColor;
  panel.hasShadow = YES;
  panel.hidesOnDeactivate = NO;
  panel.floatingPanel = YES;
  panel.becomesKeyOnlyIfNeeded = YES;
  panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                             NSWindowCollectionBehaviorFullScreenAuxiliary |
                             NSWindowCollectionBehaviorIgnoresCycle;

  NSView *root = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, kPanelWidth, height)];
  panel.contentView = root;

  NSRect cardFrame = NSMakeRect(0, 0, kPanelWidth, kCardHeight);
  NSVisualEffectView *card = [[NSVisualEffectView alloc] initWithFrame:cardFrame];
  card.material = NSVisualEffectMaterialPopover;
  card.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  card.state = NSVisualEffectStateActive;
  card.wantsLayer = YES;
  card.layer.cornerRadius = 14.0;
  card.layer.masksToBounds = YES;
  [root addSubview:card];

  CGFloat textX = 14.0 + kIconSize + 12.0;
  CGFloat textWidth = kPanelWidth - textX - 36.0;
  NSString *name = appPath.lastPathComponent.stringByDeletingPathExtension;
  NSTextField *nameLabel = [NSTextField labelWithString:name];
  nameLabel.font = [NSFont boldSystemFontOfSize:14.0];
  nameLabel.lineBreakMode = NSLineBreakByTruncatingTail;
  nameLabel.frame = NSMakeRect(textX, 44.0, textWidth, 20.0);
  [card addSubview:nameLabel];

  NSTextField *hint = [NSTextField wrappingLabelWithString:title];
  hint.font = [NSFont systemFontOfSize:12.0];
  hint.textColor = NSColor.secondaryLabelColor;
  hint.maximumNumberOfLines = 2;
  hint.frame = NSMakeRect(textX, 8.0, textWidth, 34.0);
  [card addSubview:hint];

  // On top of the labels so the whole card starts the drag.
  AppDragView *drag = [[AppDragView alloc]
      initWithFrame:NSMakeRect(0, 0, kPanelWidth - 32.0, kCardHeight)];
  drag.appURL = [NSURL fileURLWithPath:appPath isDirectory:YES];
  drag.icon = [NSWorkspace.sharedWorkspace iconForFile:appPath];
  drag.icon.size = NSMakeSize(kIconSize, kIconSize);
  drag.iconRect = NSMakeRect(14.0, (kCardHeight - kIconSize) / 2.0, kIconSize,
                             kIconSize);
  [card addSubview:drag];

  gCloseTarget = [[CloseTarget alloc] init];
  NSImage *xmark = [NSImage imageWithSystemSymbolName:@"xmark.circle.fill"
                             accessibilityDescription:@"Close"];
  NSButton *close = [NSButton buttonWithImage:xmark
                                       target:gCloseTarget
                                       action:@selector(close:)];
  close.bordered = NO;
  close.contentTintColor = NSColor.tertiaryLabelColor;
  close.frame = NSMakeRect(kPanelWidth - 28.0, kCardHeight - 26.0, 18.0, 18.0);
  [card addSubview:close];

  ArrowView *arrow = [[ArrowView alloc]
      initWithFrame:NSMakeRect(kPanelWidth / 2.0 - 20.0, kCardHeight, 40.0,
                               kArrowHeight)];
  [root addSubview:arrow];
  return panel;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *appPath = nil;
    NSString *title = @"Drag this into the list above";
    pid_t parent = 0;
    for (int i = 1; i < argc; i++) {
      NSString *arg = @(argv[i]);
      if (i + 1 >= argc) {
        usage();
        return 2;
      }
      NSString *value = @(argv[++i]);
      if ([arg isEqualToString:@"--app"]) {
        appPath = value.stringByStandardizingPath;
      } else if ([arg isEqualToString:@"--title"]) {
        title = value;
      } else if ([arg isEqualToString:@"--parent"]) {
        parent = (pid_t)value.intValue;
      } else {
        usage();
        return 2;
      }
    }
    BOOL directory = NO;
    if (appPath == nil ||
        ![NSFileManager.defaultManager fileExistsAtPath:appPath
                                            isDirectory:&directory] ||
        !directory) {
      fprintf(stderr, "permission-drag: --app must name an existing .app bundle\n");
      usage();
      return 2;
    }
    if (parent > 0 && kill(parent, 0) != 0) {
      return 0;
    }

    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    gSources = [NSMutableArray array];
    for (int sig = 0; sig < 3; sig++) {
      int signals[] = {SIGTERM, SIGINT, SIGHUP};
      signal(signals[sig], SIG_IGN);
      exitOn(dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,
                                    (uintptr_t)signals[sig], 0,
                                    dispatch_get_main_queue()));
    }
    if (parent > 0) {
      exitOn(dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC,
                                    (uintptr_t)parent, DISPATCH_PROC_EXIT,
                                    dispatch_get_main_queue()));
    }

    gPanel = makePanel(appPath, title);
    follow();
    [NSTimer scheduledTimerWithTimeInterval:kFollowInterval
                                    repeats:YES
                                      block:^(NSTimer *timer) {
                                        follow();
                                      }];
    [NSApp run];
  }
  return 0;
}
