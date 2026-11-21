// virtual-space: a display OpenCUA owns for agents, and the picture-in-picture
// that shows it to the person.
//
//   virtual-space --create [--width 1920 --height 1080 --name <text>] [--pip]
//       Creates a CGVirtualDisplay (private CoreGraphics classes; prints
//       {"error":"unsupported",...} and exits 2 when they are missing) and
//       prints one JSON line {"displayId":N,"width":..,"height":..,"x":..,"y":..}
//       in global points from the top-left of the main display. The display
//       lives until stdin closes, `quit`, or SIGTERM, then is released. It is
//       never mirrored.
//       --pip shows it live in a non-activating panel at the bottom-left of the
//       main display: collapsed (thumbnail + status), expanded (about 60% of the
//       main display) or minimized (a round pill). While the person has taken
//       over, their clicks, drags, scrolls and keys inside the expanded mirror
//       are forwarded to the virtual display.
//       Stdout events: {"event":"takeover"} {"event":"resume"}
//                      {"event":"state","state":"collapsed|expanded|minimized"}
//       Stdin commands: status <text> | state <state> | takeover | resume | quit
//
//   virtual-space --snapshot <png> --state <state> [--frame <png>]
//                 [--status <text>] [--taken-over]
//       Renders the picture-in-picture offscreen into a PNG. Creates no display
//       and shows no window.
#import <Cocoa/Cocoa.h>
#import <CoreImage/CoreImage.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

// Private CoreGraphics classes, declared the way DeskPad does. They are looked
// up with NSClassFromString, so a macOS without them fails cleanly.
@class CGVirtualDisplay;
@interface CGVirtualDisplayDescriptor : NSObject
@property(strong, nonatomic) dispatch_queue_t queue;
@property(strong, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int serialNum;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
@property(copy, nonatomic) void (^terminationHandler)(id, CGVirtualDisplay *);
@end
@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(NSUInteger)width
                       height:(NSUInteger)height
                  refreshRate:(CGFloat)refreshRate;
@end
@interface CGVirtualDisplaySettings : NSObject
@property(strong, nonatomic) NSArray<CGVirtualDisplayMode *> *modes;
@property(nonatomic) unsigned int hiDPI;
@end
@interface CGVirtualDisplay : NSObject
@property(readonly, nonatomic) CGDirectDisplayID displayID;
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

typedef NS_ENUM(NSInteger, PipState) {
  PipStateCollapsed,
  PipStateExpanded,
  PipStateMinimized,
};

static const CGFloat kMargin = 16;
static const CGFloat kThumbWidth = 240;
static const CGFloat kThumbHeight = 135;
static const CGFloat kBarHeight = 30;
static const CGFloat kPillSize = 28;
static const CGFloat kToolbarHeight = 40;
static const CGFloat kInset = 8;

static CGVirtualDisplay *gDisplay;
static CGRect gDisplayBounds;
static pid_t gKeyTargetPid = 0;

static void emit(NSDictionary *object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                 options:0
                                                   error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static NSString *state_name(PipState state) {
  switch (state) {
  case PipStateCollapsed:
    return @"collapsed";
  case PipStateExpanded:
    return @"expanded";
  case PipStateMinimized:
    return @"minimized";
  }
  return @"collapsed";
}

static BOOL parse_state(NSString *text, PipState *state) {
  if ([text isEqualToString:@"collapsed"])
    *state = PipStateCollapsed;
  else if ([text isEqualToString:@"expanded"])
    *state = PipStateExpanded;
  else if ([text isEqualToString:@"minimized"])
    *state = PipStateMinimized;
  else
    return NO;
  return YES;
}

static NSColor *agent_blue(void) {
  return [NSColor colorWithRed:0.24 green:0.53 blue:1.0 alpha:1];
}
static NSColor *takeover_orange(void) {
  return [NSColor colorWithRed:1.0 green:0.56 blue:0.16 alpha:1];
}

static NSRect fit_rect(CGSize content, NSRect box) {
  if (content.width <= 0 || content.height <= 0)
    return box;
  CGFloat scale = MIN(box.size.width / content.width,
                      box.size.height / content.height);
  CGFloat width = round(content.width * scale);
  CGFloat height = round(content.height * scale);
  return NSMakeRect(round(NSMidX(box) - width / 2),
                    round(NSMidY(box) - height / 2), width, height);
}

static NSRect main_visible_frame(void) {
  NSScreen *screen = NSScreen.screens.firstObject ?: NSScreen.mainScreen;
  return screen.visibleFrame;
}

static NSSize expanded_size(CGSize display) {
  NSRect visible = main_visible_frame();
  CGFloat width = round(visible.size.width * 0.6);
  CGFloat mirrorHeight = (width - 2 * kInset) * display.height / display.width;
  CGFloat height = kToolbarHeight + mirrorHeight + kInset;
  CGFloat maxHeight = visible.size.height - 2 * kMargin;
  if (height > maxHeight) {
    height = maxHeight;
    mirrorHeight = height - kToolbarHeight - kInset;
    width = mirrorHeight * display.width / display.height + 2 * kInset;
  }
  return NSMakeSize(round(width), round(height));
}

static void forward_mouse(CGEventType type, CGPoint point,
                          CGMouseButton button, int64_t clicks) {
  CGEventRef current = CGEventCreate(NULL);
  CGPoint home = CGEventGetLocation(current);
  CFRelease(current);
  CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, button);
  CGEventSetIntegerValueField(event, kCGMouseEventClickState, clicks);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  // The person's pointer stays over the mirror they are working in.
  CGWarpMouseCursorPosition(home);
  CGAssociateMouseAndMouseCursorPosition(true);
}

// The app whose window is frontmost at a point on the virtual display: keys
// typed into the mirror go to it, per PID, never to the person's front app.
static pid_t window_owner_at(CGPoint point) {
  CFArrayRef windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  pid_t owner = 0;
  for (NSDictionary *window in (__bridge NSArray *)windows) {
    CGRect bounds;
    if ([window[(id)kCGWindowLayer] intValue] != 0 ||
        !CGRectMakeWithDictionaryRepresentation(
            (__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds) ||
        !CGRectContainsPoint(bounds, point))
      continue;
    pid_t pid = [window[(id)kCGWindowOwnerPID] intValue];
    if (pid != getpid()) {
      owner = pid;
      break;
    }
  }
  if (windows != NULL)
    CFRelease(windows);
  return owner;
}

@class SpaceView;
@protocol SpaceViewDelegate
- (void)spaceView:(SpaceView *)view wantsState:(PipState)state;
- (void)spaceViewToggledTakeover:(SpaceView *)view;
@end

@interface SpaceView : NSView
@property(nonatomic) PipState state;
@property(nonatomic) BOOL takenOver;
@property(nonatomic, copy) NSString *status;
@property(nonatomic, copy) NSString *previewNote;
@property(nonatomic, strong) NSImage *frameImage;
@property(nonatomic) CGSize displaySize;
@property(nonatomic) CGFloat pulse;
@property(nonatomic, weak) id<SpaceViewDelegate> delegate;
@end

@implementation SpaceView {
  BOOL _forwarding;
}
- (BOOL)isFlipped {
  return YES;
}
- (BOOL)acceptsFirstMouse:(NSEvent *)event {
  (void)event;
  return YES;
}
- (BOOL)acceptsFirstResponder {
  return YES;
}

- (NSRect)closeButtonRect {
  CGFloat size = self.state == PipStateExpanded ? 26 : 20;
  CGFloat top = self.state == PipStateExpanded ? 7 : 8;
  return NSMakeRect(self.bounds.size.width - 8 - size, top, size, size);
}
- (NSRect)resizeButtonRect {
  NSRect minimize = self.closeButtonRect;
  return NSOffsetRect(minimize, -(minimize.size.width + 6), 0);
}
- (NSRect)takeoverButtonRect {
  if (self.state == PipStateExpanded) {
    NSRect resize = self.resizeButtonRect;
    return NSMakeRect(NSMinX(resize) - 10 - 96, 7, 96, 26);
  }
  return NSMakeRect(kThumbWidth - 8 - 76, kThumbHeight + 5, 76, 20);
}
- (NSRect)mirrorBox {
  if (self.state == PipStateExpanded)
    return NSMakeRect(kInset, kToolbarHeight, self.bounds.size.width - 2 * kInset,
                      self.bounds.size.height - kToolbarHeight - kInset);
  return NSMakeRect(0, 0, kThumbWidth, kThumbHeight);
}
- (NSRect)mirrorRect {
  return fit_rect(self.displaySize, self.mirrorBox);
}

- (NSString *)statusText {
  if (self.takenOver)
    return self.state == PipStateExpanded ? @"You have control · agents paused"
                                          : @"You have control";
  return self.status.length > 0 ? self.status : @"Agents working";
}

- (void)drawDotAt:(NSPoint)center radius:(CGFloat)radius {
  NSColor *color = self.takenOver ? takeover_orange() : agent_blue();
  CGFloat glow = radius * (1.6 + 0.6 * self.pulse);
  [[color colorWithAlphaComponent:0.28 * (1 - self.pulse)] setFill];
  [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(center.x - glow,
                                                     center.y - glow, glow * 2,
                                                     glow * 2)] fill];
  [color setFill];
  [[NSBezierPath
      bezierPathWithOvalInRect:NSMakeRect(center.x - radius, center.y - radius,
                                          radius * 2, radius * 2)] fill];
}

- (void)drawSymbol:(NSString *)name inCircle:(NSRect)rect {
  [[NSColor colorWithWhite:0 alpha:0.55] setFill];
  [[NSBezierPath bezierPathWithOvalInRect:rect] fill];
  [[NSColor colorWithWhite:1 alpha:0.18] setStroke];
  NSBezierPath *ring =
      [NSBezierPath bezierPathWithOvalInRect:NSInsetRect(rect, 0.5, 0.5)];
  ring.lineWidth = 1;
  [ring stroke];
  NSImageSymbolConfiguration *config = [[NSImageSymbolConfiguration
      configurationWithPointSize:rect.size.width * 0.5
                          weight:NSFontWeightSemibold]
      configurationByApplyingConfiguration:
          [NSImageSymbolConfiguration
              configurationWithHierarchicalColor:NSColor.whiteColor]];
  NSImage *symbol = [[NSImage imageWithSystemSymbolName:name
                               accessibilityDescription:nil]
      imageWithSymbolConfiguration:config];
  NSSize size = symbol.size;
  [symbol drawInRect:NSMakeRect(round(NSMidX(rect) - size.width / 2),
                                round(NSMidY(rect) - size.height / 2),
                                size.width, size.height)
            fromRect:NSZeroRect
           operation:NSCompositingOperationSourceOver
            fraction:1
      respectFlipped:YES
               hints:nil];
}

- (void)drawPill:(NSRect)rect fontSize:(CGFloat)fontSize {
  NSString *title = self.takenOver ? @"Resume" : @"Take over";
  NSColor *fill = self.takenOver ? agent_blue()
                                 : [NSColor colorWithWhite:1 alpha:0.16];
  [fill setFill];
  [[NSBezierPath bezierPathWithRoundedRect:rect
                                   xRadius:rect.size.height / 2
                                   yRadius:rect.size.height / 2] fill];
  NSDictionary *attributes = @{
    NSFontAttributeName : [NSFont systemFontOfSize:fontSize
                                            weight:NSFontWeightSemibold],
    NSForegroundColorAttributeName : NSColor.whiteColor
  };
  NSSize size = [title sizeWithAttributes:attributes];
  [title drawAtPoint:NSMakePoint(round(NSMidX(rect) - size.width / 2),
                                 round(NSMidY(rect) - size.height / 2))
      withAttributes:attributes];
}

- (void)drawText:(NSString *)text
          inRect:(NSRect)rect
            size:(CGFloat)size
          weight:(NSFontWeight)weight
           color:(NSColor *)color {
  [self drawText:text
          inRect:rect
            size:size
          weight:weight
           color:color
       alignment:NSTextAlignmentLeft];
}

- (void)drawText:(NSString *)text
          inRect:(NSRect)rect
            size:(CGFloat)size
          weight:(NSFontWeight)weight
           color:(NSColor *)color
       alignment:(NSTextAlignment)alignment {
  NSMutableParagraphStyle *paragraph = [NSMutableParagraphStyle new];
  paragraph.lineBreakMode = NSLineBreakByTruncatingTail;
  paragraph.alignment = alignment;
  NSDictionary *attributes = @{
    NSFontAttributeName : [NSFont systemFontOfSize:size weight:weight],
    NSForegroundColorAttributeName : color,
    NSParagraphStyleAttributeName : paragraph
  };
  CGFloat height = [text sizeWithAttributes:attributes].height;
  [text drawInRect:NSMakeRect(rect.origin.x,
                              round(NSMidY(rect) - height / 2),
                              rect.size.width, height)
      withAttributes:attributes];
}

- (void)drawMirrorInBox:(NSRect)box {
  [NSColor.blackColor setFill];
  NSRectFill(box);
  NSRect mirror = self.mirrorRect;
  if (self.frameImage != nil) {
    [self.frameImage drawInRect:mirror
                       fromRect:NSZeroRect
                      operation:NSCompositingOperationSourceOver
                       fraction:1
                 respectFlipped:YES
                          hints:nil];
    return;
  }
  NSString *note = self.previewNote.length > 0 ? self.previewNote
                                               : @"Waiting for the agent space…";
  CGFloat size = self.state == PipStateExpanded ? 15 : 11;
  [self drawText:note
          inRect:NSInsetRect(mirror, 12, 0)
            size:size
          weight:NSFontWeightMedium
           color:[NSColor colorWithWhite:1 alpha:0.55]
       alignment:NSTextAlignmentCenter];
}

- (void)drawBorder:(NSBezierPath *)card {
  if (self.takenOver) {
    [takeover_orange() setStroke];
    card.lineWidth = 2;
  } else {
    [[NSColor colorWithWhite:1 alpha:0.14] setStroke];
    card.lineWidth = 1;
  }
  [card stroke];
}

- (void)drawMinimized {
  NSRect rect = NSInsetRect(self.bounds, 1, 1);
  [[NSColor colorWithWhite:0.08 alpha:0.94] setFill];
  NSBezierPath *pill = [NSBezierPath bezierPathWithOvalInRect:rect];
  [pill fill];
  [self drawBorder:pill];
  [self drawDotAt:NSMakePoint(NSMidX(rect), NSMidY(rect)) radius:5];
}

- (void)drawCollapsed {
  NSRect bounds = NSInsetRect(self.bounds, 1, 1);
  NSBezierPath *card = [NSBezierPath bezierPathWithRoundedRect:bounds
                                                       xRadius:12
                                                       yRadius:12];
  [[NSColor colorWithWhite:0.08 alpha:0.96] setFill];
  [card fill];
  [NSGraphicsContext saveGraphicsState];
  [card addClip];
  [self drawMirrorInBox:self.mirrorBox];
  [NSGraphicsContext restoreGraphicsState];
  [self drawSymbol:@"minus" inCircle:self.closeButtonRect];
  [self drawSymbol:@"arrow.up.left.and.arrow.down.right"
          inCircle:self.resizeButtonRect];
  CGFloat barMid = kThumbHeight + kBarHeight / 2;
  [self drawDotAt:NSMakePoint(14, barMid) radius:4];
  NSRect pill = self.takeoverButtonRect;
  [self drawText:self.statusText
          inRect:NSMakeRect(26, kThumbHeight, NSMinX(pill) - 32, kBarHeight)
            size:11
          weight:NSFontWeightMedium
           color:NSColor.whiteColor];
  [self drawPill:pill fontSize:11];
  [self drawBorder:card];
}

- (void)drawExpanded {
  NSRect bounds = NSInsetRect(self.bounds, 1, 1);
  NSBezierPath *card = [NSBezierPath bezierPathWithRoundedRect:bounds
                                                       xRadius:14
                                                       yRadius:14];
  [[NSColor colorWithWhite:0.08 alpha:0.97] setFill];
  [card fill];
  [self drawDotAt:NSMakePoint(20, kToolbarHeight / 2) radius:5];
  NSRect pill = self.takeoverButtonRect;
  NSString *title = @"Agent space";
  NSDictionary *titleAttributes = @{
    NSFontAttributeName : [NSFont systemFontOfSize:13
                                            weight:NSFontWeightSemibold]
  };
  CGFloat titleWidth = [title sizeWithAttributes:titleAttributes].width;
  [self drawText:title
          inRect:NSMakeRect(34, 0, titleWidth + 2, kToolbarHeight)
            size:13
          weight:NSFontWeightSemibold
           color:NSColor.whiteColor];
  CGFloat statusX = 34 + titleWidth + 12;
  [self drawText:self.statusText
          inRect:NSMakeRect(statusX, 0, NSMinX(pill) - statusX - 12,
                            kToolbarHeight)
            size:12
          weight:NSFontWeightRegular
           color:self.takenOver ? takeover_orange()
                                : [NSColor colorWithWhite:1 alpha:0.6]];
  [self drawPill:pill fontSize:12];
  [self drawSymbol:@"arrow.down.right.and.arrow.up.left"
          inCircle:self.resizeButtonRect];
  [self drawSymbol:@"minus" inCircle:self.closeButtonRect];
  NSRect box = self.mirrorBox;
  [NSGraphicsContext saveGraphicsState];
  [[NSBezierPath bezierPathWithRoundedRect:box xRadius:8 yRadius:8] addClip];
  [self drawMirrorInBox:box];
  [NSGraphicsContext restoreGraphicsState];
  if (self.takenOver) {
    NSBezierPath *frame = [NSBezierPath
        bezierPathWithRoundedRect:NSInsetRect(self.mirrorRect, 1, 1)
                          xRadius:4
                          yRadius:4];
    frame.lineWidth = 2;
    [takeover_orange() setStroke];
    [frame stroke];
  }
  [self drawBorder:card];
}

- (void)drawRect:(NSRect)dirty {
  (void)dirty;
  switch (self.state) {
  case PipStateMinimized:
    [self drawMinimized];
    break;
  case PipStateCollapsed:
    [self drawCollapsed];
    break;
  case PipStateExpanded:
    [self drawExpanded];
    break;
  }
}

// Maps a point in the expanded mirror to global display coordinates.
- (BOOL)globalPoint:(CGPoint *)out forEvent:(NSEvent *)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  NSRect mirror = self.mirrorRect;
  if (self.state != PipStateExpanded || !self.takenOver ||
      !NSPointInRect(point, mirror) || CGRectIsEmpty(gDisplayBounds))
    return NO;
  out->x = gDisplayBounds.origin.x + (point.x - NSMinX(mirror)) /
                                         mirror.size.width *
                                         gDisplayBounds.size.width;
  out->y = gDisplayBounds.origin.y + (point.y - NSMinY(mirror)) /
                                         mirror.size.height *
                                         gDisplayBounds.size.height;
  return YES;
}

- (void)mouseDown:(NSEvent *)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  switch (self.state) {
  case PipStateMinimized:
    [self.delegate spaceView:self wantsState:PipStateCollapsed];
    return;
  case PipStateCollapsed:
  case PipStateExpanded:
    break;
  }
  if (NSPointInRect(point, self.closeButtonRect)) {
    [self.delegate spaceView:self wantsState:PipStateMinimized];
    return;
  }
  if (NSPointInRect(point, self.resizeButtonRect)) {
    [self.delegate spaceView:self
                  wantsState:self.state == PipStateExpanded ? PipStateCollapsed
                                                            : PipStateExpanded];
    return;
  }
  if (NSPointInRect(point, self.takeoverButtonRect)) {
    [self.delegate spaceViewToggledTakeover:self];
    return;
  }
  if (self.state == PipStateCollapsed) {
    if (NSPointInRect(point, self.mirrorBox))
      [self.delegate spaceView:self wantsState:PipStateExpanded];
    return;
  }
  CGPoint global;
  if (![self globalPoint:&global forEvent:event])
    return;
  _forwarding = YES;
  [self.window makeKeyWindow];
  gKeyTargetPid = window_owner_at(global);
  forward_mouse(kCGEventLeftMouseDown, global, kCGMouseButtonLeft,
                event.clickCount);
}
- (void)mouseDragged:(NSEvent *)event {
  CGPoint global;
  if (_forwarding && [self globalPoint:&global forEvent:event])
    forward_mouse(kCGEventLeftMouseDragged, global, kCGMouseButtonLeft,
                  event.clickCount);
}
- (void)mouseUp:(NSEvent *)event {
  CGPoint global;
  if (_forwarding && [self globalPoint:&global forEvent:event])
    forward_mouse(kCGEventLeftMouseUp, global, kCGMouseButtonLeft,
                  event.clickCount);
  _forwarding = NO;
}
- (void)rightMouseDown:(NSEvent *)event {
  CGPoint global;
  if ([self globalPoint:&global forEvent:event]) {
    gKeyTargetPid = window_owner_at(global);
    forward_mouse(kCGEventRightMouseDown, global, kCGMouseButtonRight,
                  event.clickCount);
  }
}
- (void)rightMouseUp:(NSEvent *)event {
  CGPoint global;
  if ([self globalPoint:&global forEvent:event])
    forward_mouse(kCGEventRightMouseUp, global, kCGMouseButtonRight,
                  event.clickCount);
}
- (void)scrollWheel:(NSEvent *)event {
  CGPoint global;
  if (![self globalPoint:&global forEvent:event] || event.CGEvent == NULL)
    return;
  CGEventRef current = CGEventCreate(NULL);
  CGPoint home = CGEventGetLocation(current);
  CFRelease(current);
  CGEventRef scroll = CGEventCreateCopy(event.CGEvent);
  CGEventSetLocation(scroll, global);
  // Scroll goes to the window under the pointer, so the pointer visits the
  // point for the one event and comes straight back.
  CGWarpMouseCursorPosition(global);
  CGEventPost(kCGHIDEventTap, scroll);
  CFRelease(scroll);
  CGWarpMouseCursorPosition(home);
  CGAssociateMouseAndMouseCursorPosition(true);
}
- (void)forwardKey:(NSEvent *)event {
  if (self.state != PipStateExpanded || !self.takenOver || gKeyTargetPid <= 0 ||
      event.CGEvent == NULL)
    return;
  CGEventRef key = CGEventCreateCopy(event.CGEvent);
  CGEventPostToPid(gKeyTargetPid, key);
  CFRelease(key);
}
- (void)keyDown:(NSEvent *)event {
  [self forwardKey:event];
}
- (void)keyUp:(NSEvent *)event {
  [self forwardKey:event];
}
- (void)flagsChanged:(NSEvent *)event {
  [self forwardKey:event];
}
@end

@interface SpacePanel : NSPanel
@end
@implementation SpacePanel
- (BOOL)canBecomeKeyWindow {
  SpaceView *view = (SpaceView *)self.contentView;
  return view.state == PipStateExpanded && view.takenOver;
}
@end

@interface PipController : NSObject <SpaceViewDelegate, SCStreamOutput,
                                     SCStreamDelegate>
@property(nonatomic, strong) SpacePanel *panel;
@property(nonatomic, strong) SpaceView *view;
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) SCContentFilter *filter;
@property(nonatomic, strong) SCStreamConfiguration *configuration;
@property(nonatomic, strong) CIContext *imageContext;
@property(nonatomic, strong) NSTimer *fallback;
@end

@implementation PipController
- (NSRect)frameForState:(PipState)state {
  NSRect visible = main_visible_frame();
  NSSize size;
  switch (state) {
  case PipStateMinimized:
    size = NSMakeSize(kPillSize, kPillSize);
    break;
  case PipStateCollapsed:
    size = NSMakeSize(kThumbWidth, kThumbHeight + kBarHeight);
    break;
  case PipStateExpanded:
    size = expanded_size(self.view.displaySize);
    break;
  }
  return NSMakeRect(NSMinX(visible) + kMargin, NSMinY(visible) + kMargin,
                    size.width, size.height);
}

- (void)applyState:(PipState)state {
  self.view.state = state;
  [self.panel setFrame:[self frameForState:state] display:YES];
  self.view.frame = NSMakeRect(0, 0, self.panel.frame.size.width,
                               self.panel.frame.size.height);
  [self.view setNeedsDisplay:YES];
}

- (void)spaceView:(SpaceView *)view wantsState:(PipState)state {
  (void)view;
  [self applyState:state];
  emit(@{@"event" : @"state", @"state" : state_name(state)});
}

- (void)spaceViewToggledTakeover:(SpaceView *)view {
  view.takenOver = !view.takenOver;
  [view setNeedsDisplay:YES];
  emit(@{@"event" : view.takenOver ? @"takeover" : @"resume"});
}

- (void)showFrame:(CGImageRef)image {
  NSImage *frame = [[NSImage alloc] initWithCGImage:image size:NSZeroSize];
  dispatch_async(dispatch_get_main_queue(), ^{
    self.view.frameImage = frame;
    self.view.previewNote = nil;
    [self.view setNeedsDisplay:YES];
  });
}

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
  (void)stream;
  if (type != SCStreamOutputTypeScreen)
    return;
  CVImageBufferRef pixels = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (pixels == NULL)
    return;
  CIImage *image = [CIImage imageWithCVImageBuffer:pixels];
  CGImageRef frame = [self.imageContext createCGImage:image
                                             fromRect:image.extent];
  if (frame == NULL)
    return;
  [self showFrame:frame];
  CGImageRelease(frame);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  (void)stream;
  fprintf(stderr, "virtual-space: stream stopped: %s\n",
          error.localizedDescription.UTF8String);
  dispatch_async(dispatch_get_main_queue(), ^{
    [self startFallback];
  });
}

// When the stream cannot run, a still image every 0.3 s keeps the mirror
// roughly live.
- (void)startFallback {
  if (self.fallback != nil || self.filter == nil)
    return;
  self.stream = nil;
  self.fallback = [NSTimer
      scheduledTimerWithTimeInterval:0.3
                             repeats:YES
                               block:^(NSTimer *timer) {
                                 (void)timer;
                                 [SCScreenshotManager
                                     captureImageWithFilter:self.filter
                                              configuration:self.configuration
                                          completionHandler:^(
                                              CGImageRef image,
                                              NSError *error) {
                                            (void)error;
                                            if (image != NULL)
                                              [self showFrame:image];
                                          }];
                               }];
}

- (void)startCapture:(CGDirectDisplayID)displayID attempt:(int)attempt {
  [SCShareableContent getShareableContentWithCompletionHandler:^(
                          SCShareableContent *content, NSError *error) {
    SCDisplay *match = nil;
    for (SCDisplay *display in content.displays) {
      if (display.displayID == displayID)
        match = display;
    }
    if (match == nil) {
      dispatch_after(
          dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
          dispatch_get_main_queue(), ^{
            if (attempt < 10) {
              [self startCapture:displayID attempt:attempt + 1];
              return;
            }
            self.view.previewNote =
                error != nil ? @"No preview: allow Screen Recording"
                             : @"No preview available";
            [self.view setNeedsDisplay:YES];
          });
      return;
    }
    SCContentFilter *filter =
        [[SCContentFilter alloc] initWithDisplay:match excludingWindows:@[]];
    SCStreamConfiguration *configuration = [SCStreamConfiguration new];
    CGFloat scale = MIN(1.0, 1280.0 / MAX(1, match.width));
    configuration.width = (size_t)round(match.width * scale);
    configuration.height = (size_t)round(match.height * scale);
    configuration.minimumFrameInterval = CMTimeMake(1, 10);
    configuration.pixelFormat = kCVPixelFormatType_32BGRA;
    configuration.showsCursor = YES;
    configuration.queueDepth = 3;
    dispatch_async(dispatch_get_main_queue(), ^{
      self.filter = filter;
      self.configuration = configuration;
      SCStream *stream = [[SCStream alloc] initWithFilter:filter
                                            configuration:configuration
                                                 delegate:self];
      NSError *addError = nil;
      if (![stream addStreamOutput:self
                              type:SCStreamOutputTypeScreen
                sampleHandlerQueue:dispatch_get_global_queue(
                                       QOS_CLASS_USER_INITIATED, 0)
                             error:&addError]) {
        [self startFallback];
        return;
      }
      self.stream = stream;
      [stream startCaptureWithCompletionHandler:^(NSError *startError) {
        if (startError != nil)
          dispatch_async(dispatch_get_main_queue(), ^{
            [self startFallback];
          });
      }];
    });
  }];
}
@end

static PipController *make_pip(CGSize displaySize) {
  PipController *controller = [PipController new];
  SpaceView *view = [[SpaceView alloc]
      initWithFrame:NSMakeRect(0, 0, kThumbWidth, kThumbHeight + kBarHeight)];
  view.displaySize = displaySize;
  view.delegate = controller;
  SpacePanel *panel = [[SpacePanel alloc]
      initWithContentRect:view.frame
                styleMask:NSWindowStyleMaskBorderless |
                          NSWindowStyleMaskNonactivatingPanel
                  backing:NSBackingStoreBuffered
                    defer:NO];
  panel.level = NSStatusWindowLevel;
  panel.opaque = NO;
  panel.backgroundColor = NSColor.clearColor;
  panel.hasShadow = YES;
  panel.hidesOnDeactivate = NO;
  panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                             NSWindowCollectionBehaviorFullScreenAuxiliary |
                             NSWindowCollectionBehaviorStationary;
  panel.contentView = view;
  controller.panel = panel;
  controller.view = view;
  controller.imageContext = [CIContext contextWithOptions:nil];
  return controller;
}

static void finish_space(int code) {
  gDisplay = nil;
  exit(code);
}

static void handle_command(PipController *pip, NSString *line) {
  if ([line isEqualToString:@"quit"]) {
    finish_space(0);
  }
  if (pip == nil)
    return;
  if ([line hasPrefix:@"status "]) {
    pip.view.status = [line substringFromIndex:7];
  } else if ([line hasPrefix:@"state "]) {
    PipState state;
    if (parse_state([line substringFromIndex:6], &state))
      [pip applyState:state];
  } else if ([line isEqualToString:@"takeover"]) {
    pip.view.takenOver = YES;
  } else if ([line isEqualToString:@"resume"]) {
    pip.view.takenOver = NO;
  }
  [pip.view setNeedsDisplay:YES];
}

static void read_commands(PipController *pip) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    char *buffer = NULL;
    size_t capacity = 0;
    while (getline(&buffer, &capacity, stdin) > 0) {
      NSString *line = [@(buffer)
          stringByTrimmingCharactersInSet:NSCharacterSet
                                              .whitespaceAndNewlineCharacterSet];
      dispatch_async(dispatch_get_main_queue(), ^{
        handle_command(pip, line);
      });
    }
    free(buffer);
    dispatch_async(dispatch_get_main_queue(), ^{
      finish_space(0);
    });
  });
}

// A newly created display is put into the arrangement asynchronously; wait
// for it, make sure nothing mirrors it, then report where it is.
static void announce_when_online(CGDirectDisplayID displayID, int attempt,
                                 PipController *pip) {
  CGRect bounds = CGDisplayBounds(displayID);
  if (CGRectIsEmpty(bounds) && attempt < 60) {
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.05 * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
          announce_when_online(displayID, attempt + 1, pip);
        });
    return;
  }
  if (CGRectIsEmpty(bounds)) {
    emit(@{
      @"error" : @"offline",
      @"message" : @"the virtual display never came online"
    });
    finish_space(1);
  }
  if (CGDisplayMirrorsDisplay(displayID) != kCGNullDirectDisplay ||
      CGDisplayIsInMirrorSet(displayID)) {
    CGDisplayConfigRef config;
    if (CGBeginDisplayConfiguration(&config) == kCGErrorSuccess) {
      CGConfigureDisplayMirrorOfDisplay(config, displayID,
                                        kCGNullDirectDisplay);
      CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
    }
    bounds = CGDisplayBounds(displayID);
  }
  gDisplayBounds = bounds;
  emit(@{
    @"displayId" : @(displayID),
    @"width" : @(round(bounds.size.width)),
    @"height" : @(round(bounds.size.height)),
    @"x" : @(round(bounds.origin.x)),
    @"y" : @(round(bounds.origin.y))
  });
  if (pip != nil) {
    [pip applyState:PipStateCollapsed];
    [pip.panel orderFrontRegardless];
    [pip startCapture:displayID attempt:0];
    [NSTimer scheduledTimerWithTimeInterval:0.08
                                    repeats:YES
                                      block:^(NSTimer *timer) {
                                        (void)timer;
                                        pip.view.pulse = fmod(
                                            NSDate.timeIntervalSinceReferenceDate /
                                                1.4,
                                            1.0);
                                        [pip.view setNeedsDisplay:YES];
                                      }];
  }
}

static int create_space(NSString *name, unsigned width, unsigned height,
                        BOOL withPip) {
  Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
  Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
  Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
  Class displayClass = NSClassFromString(@"CGVirtualDisplay");
  if (descriptorClass == nil || settingsClass == nil || modeClass == nil ||
      displayClass == nil) {
    emit(@{
      @"error" : @"unsupported",
      @"message" : @"this macOS has no CGVirtualDisplay; virtual spaces are "
                   @"unavailable"
    });
    return 2;
  }
  NSApplication *app = NSApplication.sharedApplication;
  app.activationPolicy = NSApplicationActivationPolicyAccessory;
  CGVirtualDisplayDescriptor *descriptor = [descriptorClass new];
  descriptor.queue = dispatch_get_main_queue();
  descriptor.name = name;
  descriptor.maxPixelsWide = width;
  descriptor.maxPixelsHigh = height;
  // About 110 dpi, a typical desktop monitor.
  descriptor.sizeInMillimeters =
      CGSizeMake(width * 25.4 / 110.0, height * 25.4 / 110.0);
  descriptor.vendorID = 0x4F43;
  descriptor.productID = 0x5541;
  descriptor.serialNum = (unsigned int)getpid();
  descriptor.terminationHandler = ^(id display, CGVirtualDisplay *virtual) {
    (void)display;
    (void)virtual;
    fprintf(stderr, "virtual-space: the system ended the display\n");
    dispatch_async(dispatch_get_main_queue(), ^{
      finish_space(1);
    });
  };
  CGVirtualDisplay *display =
      [[displayClass alloc] initWithDescriptor:descriptor];
  if (display == nil || display.displayID == 0) {
    emit(@{
      @"error" : @"create-failed",
      @"message" : @"CGVirtualDisplay refused to create the display"
    });
    return 1;
  }
  CGVirtualDisplaySettings *settings = [settingsClass new];
  settings.hiDPI = 0;
  settings.modes = @[ [[modeClass alloc] initWithWidth:width
                                                height:height
                                           refreshRate:60] ];
  if (![display applySettings:settings]) {
    emit(@{
      @"error" : @"create-failed",
      @"message" : @"CGVirtualDisplay refused the display mode"
    });
    return 1;
  }
  gDisplay = display;
  PipController *pip = withPip ? make_pip(CGSizeMake(width, height)) : nil;
  read_commands(pip);
  signal(SIGTERM, SIG_IGN);
  dispatch_source_t term = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(term, ^{
    finish_space(0);
  });
  dispatch_resume(term);
  CGDirectDisplayID displayID = display.displayID;
  dispatch_async(dispatch_get_main_queue(), ^{
    announce_when_online(displayID, 0, pip);
  });
  [app run];
  return 0;
}

static int snapshot(NSString *path, PipState state, NSString *framePath,
                    NSString *status, BOOL takenOver) {
  NSApplication *app = NSApplication.sharedApplication;
  app.activationPolicy = NSApplicationActivationPolicyAccessory;
  NSImage *frame = nil;
  if (framePath != nil) {
    frame = [[NSImage alloc] initWithContentsOfFile:framePath];
    if (frame == nil) {
      fprintf(stderr, "virtual-space: cannot read %s\n", framePath.UTF8String);
      return 1;
    }
  }
  NSBitmapImageRep *pixels = (NSBitmapImageRep *)frame.representations.firstObject;
  CGSize displaySize = [pixels isKindOfClass:NSBitmapImageRep.class]
                           ? CGSizeMake(pixels.pixelsWide, pixels.pixelsHigh)
                           : CGSizeMake(1920, 1080);
  PipController *pip = make_pip(displaySize);
  pip.view.frameImage = frame;
  pip.view.status = status;
  pip.view.takenOver = takenOver;
  pip.view.pulse = 0.35;
  [pip applyState:state];
  SpaceView *view = pip.view;
  NSBitmapImageRep *image =
      [view bitmapImageRepForCachingDisplayInRect:view.bounds];
  [view cacheDisplayInRect:view.bounds toBitmapImageRep:image];
  NSData *png = [image representationUsingType:NSBitmapImageFileTypePNG
                                    properties:@{}];
  if (![png writeToFile:path atomically:YES]) {
    fprintf(stderr, "virtual-space: cannot write %s\n", path.UTF8String);
    return 1;
  }
  emit(@{
    @"snapshot" : path,
    @"state" : state_name(state),
    @"width" : @(view.bounds.size.width),
    @"height" : @(view.bounds.size.height)
  });
  return 0;
}

static int usage(void) {
  fprintf(stderr,
          "usage: virtual-space --create [--width N --height N --name TEXT] "
          "[--pip]\n"
          "       virtual-space --snapshot PNG --state "
          "collapsed|expanded|minimized [--frame PNG] [--status TEXT] "
          "[--taken-over]\n");
  return 64;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    BOOL create = NO, withPip = NO, takenOver = NO;
    unsigned width = 1920, height = 1080;
    NSString *name = @"OpenCUA agent space";
    NSString *snapshotPath = nil, *framePath = nil, *status = nil;
    PipState state = PipStateCollapsed;
    for (int index = 1; index < argc; index++) {
      NSString *argument = @(argv[index]);
      BOOL hasValue = index + 1 < argc;
      if ([argument isEqualToString:@"--create"])
        create = YES;
      else if ([argument isEqualToString:@"--pip"])
        withPip = YES;
      else if ([argument isEqualToString:@"--taken-over"])
        takenOver = YES;
      else if ([argument isEqualToString:@"--width"] && hasValue)
        width = (unsigned)atoi(argv[++index]);
      else if ([argument isEqualToString:@"--height"] && hasValue)
        height = (unsigned)atoi(argv[++index]);
      else if ([argument isEqualToString:@"--name"] && hasValue)
        name = @(argv[++index]);
      else if ([argument isEqualToString:@"--snapshot"] && hasValue)
        snapshotPath = @(argv[++index]);
      else if ([argument isEqualToString:@"--frame"] && hasValue)
        framePath = @(argv[++index]);
      else if ([argument isEqualToString:@"--status"] && hasValue)
        status = @(argv[++index]);
      else if ([argument isEqualToString:@"--state"] && hasValue) {
        if (!parse_state(@(argv[++index]), &state))
          return usage();
      } else
        return usage();
    }
    if (snapshotPath != nil && !create)
      return snapshot(snapshotPath, state, framePath, status, takenOver);
    if (!create || snapshotPath != nil || width < 640 || height < 480 ||
        width > 7680 || height > 4320)
      return usage();
    return create_space(name, width, height, withPip);
  }
}
