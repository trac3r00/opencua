// buddy-hud: the opencua buddy's on-screen layer.
//
//   buddy-hud --listen   show a "Listening" pill while the push-to-talk keys
//   are held; the person can circle (drag) or
//                        box (Shift-drag) what they mean while talking. Ends
//                        when stdin closes or on SIGTERM.
//   buddy-hud --lasso    ask for one circle or box, ending on mouse-up; Esc
//   cancels.
//   buddy-hud --status   a pill at the bottom of the screen saying what buddy
//                        and its agents are doing (see run_status).
//   --replay <json>      draw the given strokes ([[[x,y],...], ...], screen
//   points from the top left) instead of
//                        reading the mouse; for checks that must not touch the
//                        real pointer.
//
// Prints one JSON line:
// {"marks":[{"kind":"lasso"|"box","x":..,"y":..,"width":..,"height":..}],"cancelled":false}
// in global screen points from the top-left corner of the main display, the
// space the cursor overlay uses. The panel never activates, so the person's
// front app keeps focus.
#import <Cocoa/Cocoa.h>
#include <signal.h>
#include <unistd.h>

static BOOL gLassoMode = NO;
static BOOL gFinished = NO;

@interface Stroke : NSObject
@property(nonatomic, strong) NSMutableArray<NSValue *> *points;
@property(nonatomic) BOOL box;
@end
@implementation Stroke
@end

@interface HudView : NSView
@property(nonatomic, strong) NSMutableArray<Stroke *> *strokes;
@property(nonatomic, copy) NSString *message;
@end

static void finish(HudView *view, BOOL cancelled);

static NSRect stroke_bounds(Stroke *stroke) {
  CGFloat minX = CGFLOAT_MAX, minY = CGFLOAT_MAX, maxX = -CGFLOAT_MAX,
          maxY = -CGFLOAT_MAX;
  for (NSValue *value in stroke.points) {
    NSPoint point = value.pointValue;
    minX = MIN(minX, point.x);
    minY = MIN(minY, point.y);
    maxX = MAX(maxX, point.x);
    maxY = MAX(maxY, point.y);
  }
  return NSMakeRect(minX, minY, maxX - minX, maxY - minY);
}

@implementation HudView
- (BOOL)acceptsFirstMouse:(NSEvent *)event {
  (void)event;
  return YES;
}
- (BOOL)isFlipped {
  return YES;
}
- (void)resetCursorRects {
  [self addCursorRect:self.bounds cursor:[NSCursor crosshairCursor]];
}
- (void)mouseDown:(NSEvent *)event {
  Stroke *stroke = [Stroke new];
  stroke.points = [NSMutableArray array];
  stroke.box = (event.modifierFlags & NSEventModifierFlagShift) != 0;
  [stroke.points
      addObject:[NSValue
                    valueWithPoint:[self convertPoint:event.locationInWindow
                                             fromView:nil]]];
  [self.strokes addObject:stroke];
  [self setNeedsDisplay:YES];
}
- (void)mouseDragged:(NSEvent *)event {
  Stroke *stroke = self.strokes.lastObject;
  if (stroke == nil)
    return;
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  if (stroke.box && stroke.points.count > 1)
    [stroke.points removeLastObject];
  [stroke.points addObject:[NSValue valueWithPoint:point]];
  [self setNeedsDisplay:YES];
}
- (void)mouseUp:(NSEvent *)event {
  (void)event;
  if (gLassoMode && self.strokes.count > 0)
    finish(self, NO);
}
- (void)keyDown:(NSEvent *)event {
  if (event.keyCode == 53)
    finish(self, YES);
}
- (void)drawRect:(NSRect)dirty {
  (void)dirty;
  NSColor *ink = [NSColor colorWithRed:1.0 green:0.45 blue:0.1 alpha:0.95];
  for (Stroke *stroke in self.strokes) {
    NSBezierPath *path;
    if (stroke.box) {
      NSRect rect = stroke_bounds(stroke);
      path = [NSBezierPath bezierPathWithRoundedRect:rect xRadius:6 yRadius:6];
      [[ink colorWithAlphaComponent:0.12] setFill];
      [path fill];
    } else {
      path = [NSBezierPath bezierPath];
      [stroke.points enumerateObjectsUsingBlock:^(
                         NSValue *value, NSUInteger index, BOOL *stop) {
        (void)stop;
        if (index == 0)
          [path moveToPoint:value.pointValue];
        else
          [path lineToPoint:value.pointValue];
      }];
      path.lineCapStyle = NSLineCapStyleRound;
      path.lineJoinStyle = NSLineJoinStyleRound;
    }
    path.lineWidth = 4;
    [ink setStroke];
    [path stroke];
  }
  NSDictionary *attributes = @{
    NSFontAttributeName : [NSFont systemFontOfSize:15
                                            weight:NSFontWeightSemibold],
    NSForegroundColorAttributeName : NSColor.whiteColor
  };
  NSSize size = [self.message sizeWithAttributes:attributes];
  NSRect pill = NSMakeRect((self.bounds.size.width - size.width) / 2 - 22, 46,
                           size.width + 44, size.height + 18);
  NSBezierPath *background =
      [NSBezierPath bezierPathWithRoundedRect:pill
                                      xRadius:pill.size.height / 2
                                      yRadius:pill.size.height / 2];
  [[NSColor colorWithWhite:0.08 alpha:0.86] setFill];
  [background fill];
  [[NSColor colorWithRed:1.0 green:0.3 blue:0.25 alpha:1] setFill];
  [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(NSMinX(pill) + 13,
                                                     NSMidY(pill) - 5, 10, 10)]
      fill];
  [self.message drawAtPoint:NSMakePoint(NSMinX(pill) + 30, NSMinY(pill) + 9)
             withAttributes:attributes];
}
@end

@interface HudPanel : NSPanel
@end
@implementation HudPanel
- (BOOL)canBecomeKeyWindow {
  return gLassoMode;
}
@end

static void finish(HudView *view, BOOL cancelled) {
  if (gFinished)
    return;
  gFinished = YES;
  NSPoint origin = view.window.frame.origin;
  CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
  CGFloat windowTop = top - (origin.y + view.bounds.size.height);
  NSMutableArray *marks = [NSMutableArray array];
  for (Stroke *stroke in cancelled ? @[] : view.strokes) {
    NSRect rect = stroke_bounds(stroke);
    if (rect.size.width < 6 && rect.size.height < 6)
      continue;
    [marks addObject:@{
      @"kind" : stroke.box ? @"box" : @"lasso",
      @"x" : @(round(origin.x + rect.origin.x)),
      @"y" : @(round(windowTop + rect.origin.y)),
      @"width" : @(round(rect.size.width)),
      @"height" : @(round(rect.size.height))
    }];
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{
    @"marks" : marks,
    @"cancelled" : @(cancelled)
  }
                                                 options:0
                                                   error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  exit(0);
}

// --caption: the words buddy is saying, in a small bubble the person can drag
// anywhere; it reopens where they left it (--position-file). Each stdin line
// replaces the text; stdin closing ends it. The stop button ends the speech: it
// prints {"stopped":true}.
@interface CaptionView : NSView
@property(nonatomic, strong) NSTextField *label;
@end
@implementation CaptionView
- (BOOL)acceptsFirstMouse:(NSEvent *)event {
  (void)event;
  return YES;
}
- (BOOL)mouseDownCanMoveWindow {
  return YES;
}
- (void)drawRect:(NSRect)dirty {
  (void)dirty;
  [[NSColor colorWithWhite:0.08 alpha:0.9] setFill];
  [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:14
                                   yRadius:14] fill];
}
@end

@interface CaptionController : NSObject <NSWindowDelegate>
@property(nonatomic, strong) NSPanel *panel;
@property(nonatomic, strong) CaptionView *view;
@property(nonatomic, copy) NSString *positionFile;
@end

static const CGFloat kCaptionWidth = 380;

static void caption_finish(BOOL stopped) {
  if (gFinished)
    return;
  gFinished = YES;
  printf("{\"stopped\":%s}\n", stopped ? "true" : "false");
  fflush(stdout);
  exit(0);
}

@implementation CaptionController
- (void)stop:(id)sender {
  (void)sender;
  caption_finish(YES);
}
- (void)setText:(NSString *)text {
  self.view.label.stringValue = text;
  NSSize fit = [self.view.label.cell
      cellSizeForBounds:NSMakeRect(0, 0, kCaptionWidth - 64, 10000)];
  CGFloat height = MIN(MAX(fit.height, 20), 220) + 24;
  NSRect frame = self.panel.frame;
  // Keep the top edge where the person put it while the text grows or shrinks.
  frame.origin.y += frame.size.height - height;
  frame.size.height = height;
  [self.panel setFrame:frame display:YES];
  self.view.label.frame = NSMakeRect(16, 12, kCaptionWidth - 64, height - 24);
}
- (void)windowDidMove:(NSNotification *)notification {
  (void)notification;
  if (self.positionFile == nil)
    return;
  NSRect frame = self.panel.frame;
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{
    @"x" : @(round(NSMinX(frame))),
    @"top" : @(round(NSMaxY(frame)))
  }
                                                 options:0
                                                   error:nil];
  [data writeToFile:self.positionFile atomically:YES];
}
@end

static NSPoint caption_top_left(NSString *positionFile) {
  NSRect visible = NSScreen.mainScreen.visibleFrame;
  NSPoint fallback =
      NSMakePoint(NSMidX(visible) - kCaptionWidth / 2, NSMinY(visible) + 140);
  NSData *data =
      positionFile ? [NSData dataWithContentsOfFile:positionFile] : nil;
  NSDictionary *saved = data ? [NSJSONSerialization JSONObjectWithData:data
                                                               options:0
                                                                 error:nil]
                             : nil;
  if (![saved isKindOfClass:NSDictionary.class] ||
      ![saved[@"x"] isKindOfClass:NSNumber.class] ||
      ![saved[@"top"] isKindOfClass:NSNumber.class])
    return fallback;
  NSPoint point =
      NSMakePoint([saved[@"x"] doubleValue], [saved[@"top"] doubleValue]);
  // A saved spot on a display that is gone falls back to the bottom middle of
  // the main screen.
  for (NSScreen *screen in NSScreen.screens) {
    if (NSPointInRect(NSMakePoint(point.x + 20, point.y - 10), screen.frame))
      return point;
  }
  return fallback;
}

static int run_caption(NSString *positionFile, NSString *snapshot) {
  NSApplication *app = NSApplication.sharedApplication;
  app.activationPolicy = NSApplicationActivationPolicyAccessory;
  NSPoint topLeft = caption_top_left(positionFile);
  NSPanel *panel =
      [[NSPanel alloc] initWithContentRect:NSMakeRect(topLeft.x, topLeft.y - 60,
                                                      kCaptionWidth, 60)
                                 styleMask:NSWindowStyleMaskBorderless |
                                           NSWindowStyleMaskNonactivatingPanel
                                   backing:NSBackingStoreBuffered
                                     defer:NO];
  panel.level = NSStatusWindowLevel;
  panel.opaque = NO;
  panel.backgroundColor = NSColor.clearColor;
  panel.hasShadow = YES;
  panel.movableByWindowBackground = YES;
  panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                             NSWindowCollectionBehaviorFullScreenAuxiliary;
  CaptionController *controller = [CaptionController new];
  controller.panel = panel;
  controller.positionFile = positionFile;
  CaptionView *view =
      [[CaptionView alloc] initWithFrame:NSMakeRect(0, 0, kCaptionWidth, 60)];
  view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  NSTextField *label = [NSTextField wrappingLabelWithString:@"…"];
  label.textColor = NSColor.whiteColor;
  label.font = [NSFont systemFontOfSize:14 weight:NSFontWeightMedium];
  label.maximumNumberOfLines = 10;
  [view addSubview:label];
  view.label = label;
  NSButton *stop = [NSButton buttonWithTitle:@"■"
                                      target:controller
                                      action:@selector(stop:)];
  stop.bordered = NO;
  stop.contentTintColor = [NSColor colorWithRed:1 green:0.45 blue:0.4 alpha:1];
  stop.font = [NSFont systemFontOfSize:15];
  stop.toolTip = @"Stop talking";
  stop.frame = NSMakeRect(kCaptionWidth - 40, 12, 28, 24);
  stop.autoresizingMask = NSViewMinXMargin | NSViewMaxYMargin;
  [view addSubview:stop];
  panel.contentView = view;
  controller.view = view;
  panel.delegate = controller;
  NSString *first = [[[NSString alloc]
      initWithData:[NSFileHandle.fileHandleWithStandardInput availableData]
          encoding:NSUTF8StringEncoding]
      stringByTrimmingCharactersInSet:NSCharacterSet
                                          .whitespaceAndNewlineCharacterSet];
  [controller setText:first.length > 0 ? first : @"…"];
  if (snapshot != nil) {
    NSBitmapImageRep *image =
        [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:image];
    [[image representationUsingType:NSBitmapImageFileTypePNG
                         properties:@{}] writeToFile:snapshot atomically:YES];
    caption_finish(NO);
  }
  [panel orderFrontRegardless];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSFileHandle *input = NSFileHandle.fileHandleWithStandardInput;
    for (;;) {
      NSData *chunk = [input availableData];
      if (chunk.length == 0)
        break;
      NSString *text = [[[NSString alloc] initWithData:chunk
                                              encoding:NSUTF8StringEncoding]
          stringByTrimmingCharactersInSet:
              NSCharacterSet.whitespaceAndNewlineCharacterSet];
      NSString *last = [text componentsSeparatedByString:@"\n"].lastObject;
      if (last.length > 0)
        dispatch_async(dispatch_get_main_queue(), ^{
          [controller setText:last];
        });
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      caption_finish(NO);
    });
  });
  signal(SIGTERM, SIG_IGN);
  dispatch_source_t term = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(term, ^{
    caption_finish(NO);
  });
  dispatch_resume(term);
  [app run];
  return 0;
}

// --status: a small pill at the bottom of the display the person is working on
// (the one under the pointer) that says what buddy and its agents are doing.
// Each stdin line is one JSON update:
//   {"state":"listening|hearing|thinking|working|speaking|done|error|idle",
//    "text":"...", "detail":"...", "ttl":2.5}
// "idle" hides the pill; ttl hides it after that many seconds unless another
// update arrives. The pill never takes focus, lets clicks through, and is left
// out of screen captures, so it never lands in the screenshot buddy asks about.
// stdin closing ends it.
static const CGFloat kStatusHeight = 40;
static const CGFloat kStatusDetailHeight = 56;
static const CGFloat kStatusMaxWidth = 620;
static const CGFloat kStatusBottomGap = 22;

@interface StatusView : NSView
@property(nonatomic, copy) NSString *state;
@property(nonatomic, copy) NSString *text;
@property(nonatomic, copy) NSString *detail;
@property(nonatomic) CGFloat phase;
@end

static NSColor *status_color(NSString *state) {
  if ([state isEqualToString:@"listening"] ||
      [state isEqualToString:@"hearing"])
    return [NSColor colorWithRed:1.0 green:0.3 blue:0.25 alpha:1];
  if ([state isEqualToString:@"thinking"])
    return [NSColor colorWithRed:0.35 green:0.62 blue:1.0 alpha:1];
  if ([state isEqualToString:@"working"])
    return [NSColor colorWithRed:1.0 green:0.72 blue:0.2 alpha:1];
  if ([state isEqualToString:@"speaking"])
    return [NSColor colorWithRed:0.72 green:0.5 blue:1.0 alpha:1];
  if ([state isEqualToString:@"done"])
    return [NSColor colorWithRed:0.3 green:0.85 blue:0.45 alpha:1];
  if ([state isEqualToString:@"error"])
    return [NSColor colorWithRed:1.0 green:0.55 blue:0.2 alpha:1];
  return [NSColor colorWithWhite:0.7 alpha:1];
}

static BOOL status_pulses(NSString *state) {
  return [state isEqualToString:@"listening"] ||
         [state isEqualToString:@"hearing"] ||
         [state isEqualToString:@"thinking"] ||
         [state isEqualToString:@"working"] ||
         [state isEqualToString:@"speaking"];
}

static NSDictionary *status_title_attributes(void) {
  NSMutableParagraphStyle *style = [NSMutableParagraphStyle new];
  style.lineBreakMode = NSLineBreakByTruncatingTail;
  return @{
    NSFontAttributeName : [NSFont systemFontOfSize:14
                                            weight:NSFontWeightSemibold],
    NSForegroundColorAttributeName : NSColor.whiteColor,
    NSParagraphStyleAttributeName : style
  };
}

static NSDictionary *status_detail_attributes(void) {
  NSMutableParagraphStyle *style = [NSMutableParagraphStyle new];
  style.lineBreakMode = NSLineBreakByTruncatingTail;
  return @{
    NSFontAttributeName : [NSFont systemFontOfSize:12
                                            weight:NSFontWeightRegular],
    NSForegroundColorAttributeName : [NSColor colorWithWhite:0.78 alpha:1],
    NSParagraphStyleAttributeName : style
  };
}

/** The pill's size for its text: as wide as the longer line, within bounds. */
static NSSize status_size(NSString *text, NSString *detail) {
  CGFloat width = [text sizeWithAttributes:status_title_attributes()].width;
  if (detail.length > 0)
    width = MAX(width,
                [detail sizeWithAttributes:status_detail_attributes()].width);
  return NSMakeSize(MIN(MAX(width + 58, 180), kStatusMaxWidth),
                    detail.length > 0 ? kStatusDetailHeight : kStatusHeight);
}

@implementation StatusView
- (BOOL)isFlipped {
  return YES;
}
- (void)drawRect:(NSRect)dirty {
  (void)dirty;
  NSRect bounds = self.bounds;
  NSBezierPath *background =
      [NSBezierPath bezierPathWithRoundedRect:bounds
                                      xRadius:MIN(20, bounds.size.height / 2)
                                      yRadius:MIN(20, bounds.size.height / 2)];
  [[NSColor colorWithWhite:0.08 alpha:0.88] setFill];
  [background fill];
  [[NSColor colorWithWhite:1 alpha:0.12] setStroke];
  background.lineWidth = 1;
  [background stroke];
  NSColor *color = status_color(self.state);
  CGFloat pulse =
      status_pulses(self.state) ? 0.55 + 0.45 * fabs(sin(self.phase)) : 1;
  CGFloat dot = 10;
  NSPoint center = NSMakePoint(20, 20);
  [[color colorWithAlphaComponent:0.28 * pulse] setFill];
  [[NSBezierPath
      bezierPathWithOvalInRect:NSMakeRect(center.x - dot, center.y - dot,
                                          dot * 2, dot * 2)] fill];
  [[color colorWithAlphaComponent:pulse] setFill];
  [[NSBezierPath
      bezierPathWithOvalInRect:NSMakeRect(center.x - dot / 2,
                                          center.y - dot / 2, dot, dot)] fill];
  CGFloat textWidth = bounds.size.width - 52;
  [self.text drawInRect:NSMakeRect(38, 11, textWidth, 20)
         withAttributes:status_title_attributes()];
  if (self.detail.length > 0)
    [self.detail drawInRect:NSMakeRect(38, 31, textWidth, 18)
             withAttributes:status_detail_attributes()];
}
@end

@interface StatusController : NSObject
@property(nonatomic, strong) NSPanel *panel;
@property(nonatomic, strong) StatusView *view;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) BOOL shown;
@end

/** The display the person is working on: the one under the pointer. */
static NSScreen *status_screen(void) {
  NSPoint pointer = NSEvent.mouseLocation;
  for (NSScreen *screen in NSScreen.screens) {
    if (NSPointInRect(pointer, screen.frame))
      return screen;
  }
  return NSScreen.mainScreen;
}

@implementation StatusController
- (void)tick {
  if (!self.shown || !status_pulses(self.view.state))
    return;
  self.view.phase += 0.12;
  [self.view setNeedsDisplay:YES];
}
- (void)hide {
  if (!self.shown)
    return;
  self.shown = NO;
  [NSAnimationContext
      runAnimationGroup:^(NSAnimationContext *context) {
        context.duration = 0.25;
        self.panel.animator.alphaValue = 0;
      }
      completionHandler:^{
        if (!self.shown)
          [self.panel orderOut:nil];
      }];
}
- (void)apply:(NSDictionary *)update {
  NSString *state = [update[@"state"] isKindOfClass:NSString.class]
                        ? update[@"state"]
                        : @"idle";
  self.generation += 1;
  if ([state isEqualToString:@"idle"]) {
    [self hide];
    return;
  }
  NSString *text =
      [update[@"text"] isKindOfClass:NSString.class] ? update[@"text"] : @"";
  NSString *detail = [update[@"detail"] isKindOfClass:NSString.class]
                         ? update[@"detail"]
                         : @"";
  self.view.state = state;
  self.view.text = text;
  self.view.detail = detail;
  NSSize size = status_size(text, detail);
  // A pill that is already up stays on its display; a new one appears where
  // the person is.
  NSScreen *screen =
      self.shown ? (self.panel.screen ?: status_screen()) : status_screen();
  NSRect visible = screen.visibleFrame;
  [self.panel setFrame:NSMakeRect(NSMidX(visible) - size.width / 2,
                                  NSMinY(visible) + kStatusBottomGap,
                                  size.width, size.height)
               display:YES];
  [self.view setNeedsDisplay:YES];
  if (!self.shown) {
    self.shown = YES;
    self.panel.alphaValue = 0;
    [self.panel orderFrontRegardless];
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
      context.duration = 0.15;
      self.panel.animator.alphaValue = 1;
    }];
  }
  double ttl = [update[@"ttl"] isKindOfClass:NSNumber.class]
                   ? [update[@"ttl"] doubleValue]
                   : 0;
  if (ttl > 0) {
    NSUInteger generation = self.generation;
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(ttl * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
          if (self.generation == generation)
            [self hide];
        });
  }
}
@end

static int run_status(NSString *snapshot, NSString *state, NSString *text,
                      NSString *detail) {
  NSApplication *app = NSApplication.sharedApplication;
  app.activationPolicy = NSApplicationActivationPolicyAccessory;
  StatusView *view =
      [[StatusView alloc] initWithFrame:NSMakeRect(0, 0, 200, kStatusHeight)];
  if (snapshot != nil) {
    view.state = state ?: @"thinking";
    view.text = text ?: @"";
    view.detail = detail ?: @"";
    view.phase = M_PI / 2;
    NSSize size = status_size(view.text, view.detail);
    view.frame = NSMakeRect(0, 0, size.width, size.height);
    NSBitmapImageRep *image =
        [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:image];
    BOOL written = [[image representationUsingType:NSBitmapImageFileTypePNG
                                        properties:@{}] writeToFile:snapshot
                                                         atomically:YES];
    printf("{\"snapshot\":%s,\"width\":%.0f,\"height\":%.0f}\n",
           written ? "true" : "false", view.bounds.size.width,
           view.bounds.size.height);
    return written ? 0 : 1;
  }
  NSPanel *panel =
      [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 200, kStatusHeight)
                                 styleMask:NSWindowStyleMaskBorderless |
                                           NSWindowStyleMaskNonactivatingPanel
                                   backing:NSBackingStoreBuffered
                                     defer:NO];
  panel.level = NSStatusWindowLevel;
  panel.opaque = NO;
  panel.backgroundColor = NSColor.clearColor;
  panel.hasShadow = YES;
  panel.ignoresMouseEvents = YES;
  panel.sharingType = NSWindowSharingNone;
  panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                             NSWindowCollectionBehaviorFullScreenAuxiliary |
                             NSWindowCollectionBehaviorStationary |
                             NSWindowCollectionBehaviorIgnoresCycle;
  view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  panel.contentView = view;
  StatusController *controller = [StatusController new];
  controller.panel = panel;
  controller.view = view;
  [NSTimer scheduledTimerWithTimeInterval:1.0 / 30
                                  repeats:YES
                                    block:^(NSTimer *timer) {
                                      (void)timer;
                                      [controller tick];
                                    }];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSFileHandle *input = NSFileHandle.fileHandleWithStandardInput;
    NSMutableData *pending = [NSMutableData data];
    for (;;) {
      NSData *chunk = [input availableData];
      if (chunk.length == 0)
        break;
      [pending appendData:chunk];
      for (;;) {
        NSRange newline = [pending rangeOfData:[NSData dataWithBytes:"\n"
                                                              length:1]
                                       options:0
                                         range:NSMakeRange(0, pending.length)];
        if (newline.location == NSNotFound)
          break;
        NSData *line =
            [pending subdataWithRange:NSMakeRange(0, newline.location)];
        [pending replaceBytesInRange:NSMakeRange(0, newline.location + 1)
                           withBytes:NULL
                              length:0];
        id update = [NSJSONSerialization JSONObjectWithData:line
                                                    options:0
                                                      error:nil];
        if ([update isKindOfClass:NSDictionary.class])
          dispatch_async(dispatch_get_main_queue(), ^{
            [controller apply:update];
          });
      }
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      exit(0);
    });
  });
  signal(SIGTERM, SIG_IGN);
  dispatch_source_t term = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(term, ^{
    exit(0);
  });
  dispatch_resume(term);
  [app run];
  return 0;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    NSString *replay = nil;
    BOOL status = NO;
    NSString *statusState = nil;
    NSString *statusText = nil;
    NSString *statusDetail = nil;
    NSString *positionFile = nil;
    BOOL caption = NO;
    NSString *snapshot = nil;
    BOOL listen = NO;
    for (int index = 1; index < argc; index++) {
      NSString *argument = @(argv[index]);
      if ([argument isEqualToString:@"--listen"])
        listen = YES;
      else if ([argument isEqualToString:@"--lasso"])
        gLassoMode = YES;
      else if ([argument isEqualToString:@"--replay"] && index + 1 < argc)
        replay = @(argv[++index]);
      else if ([argument isEqualToString:@"--snapshot"] && index + 1 < argc)
        snapshot = @(argv[++index]);
      else if ([argument isEqualToString:@"--caption"])
        caption = YES;
      else if ([argument isEqualToString:@"--status"])
        status = YES;
      else if ([argument isEqualToString:@"--state"] && index + 1 < argc)
        statusState = @(argv[++index]);
      else if ([argument isEqualToString:@"--text"] && index + 1 < argc)
        statusText = @(argv[++index]);
      else if ([argument isEqualToString:@"--detail"] && index + 1 < argc)
        statusDetail = @(argv[++index]);
      else if ([argument isEqualToString:@"--position-file"] &&
               index + 1 < argc)
        positionFile = @(argv[++index]);
      else {
        fprintf(stderr, "usage: buddy-hud --listen | --lasso [--replay "
                        "<json>] | --caption | --status\n");
        return 64;
      }
    }
    if (status)
      return run_status(snapshot, statusState, statusText, statusDetail);
    if (caption)
      return run_caption(positionFile, snapshot);
    if (listen == gLassoMode) {
      fprintf(stderr, "usage: pass exactly one of --listen or --lasso\n");
      return 64;
    }
    NSApplication *app = NSApplication.sharedApplication;
    app.activationPolicy = NSApplicationActivationPolicyAccessory;
    NSScreen *screen = NSScreen.mainScreen;
    HudPanel *panel = [[HudPanel alloc]
        initWithContentRect:screen.frame
                  styleMask:NSWindowStyleMaskBorderless |
                            NSWindowStyleMaskNonactivatingPanel
                    backing:NSBackingStoreBuffered
                      defer:NO];
    panel.level = NSScreenSaverWindowLevel;
    panel.opaque = NO;
    panel.backgroundColor = [NSColor colorWithWhite:0
                                              alpha:gLassoMode ? 0.12 : 0.02];
    panel.hasShadow = NO;
    panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                               NSWindowCollectionBehaviorFullScreenAuxiliary;
    HudView *view =
        [[HudView alloc] initWithFrame:NSMakeRect(0, 0, screen.frame.size.width,
                                                  screen.frame.size.height)];
    view.strokes = [NSMutableArray array];
    view.message =
        gLassoMode
            ? @"Circle or Shift-drag a box around what you mean · Esc cancels"
            : @"Listening… circle or Shift-drag a box to point";
    panel.contentView = view;
    // --snapshot renders offscreen into a PNG and never shows the panel, so
    // checks leave the screen alone.
    if (snapshot == nil) {
      [panel orderFrontRegardless];
      if (gLassoMode)
        [panel makeKeyWindow];
    }
    if (replay != nil) {
      NSArray *strokes = [NSJSONSerialization
          JSONObjectWithData:[replay dataUsingEncoding:NSUTF8StringEncoding]
                     options:0
                       error:nil];
      CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
      CGFloat windowTop = top - NSMaxY(screen.frame);
      for (NSArray *points in [strokes isKindOfClass:NSArray.class] ? strokes
                                                                    : @[]) {
        Stroke *stroke = [Stroke new];
        stroke.points = [NSMutableArray array];
        stroke.box = points.count == 2;
        for (NSArray *pair in points) {
          [stroke.points
              addObject:[NSValue valueWithPoint:NSMakePoint(
                                                    [pair[0] doubleValue] -
                                                        screen.frame.origin.x,
                                                    [pair[1] doubleValue] -
                                                        windowTop)]];
        }
        [view.strokes addObject:stroke];
      }
      [view setNeedsDisplay:YES];
    }
    if (snapshot != nil) {
      NSBitmapImageRep *image =
          [view bitmapImageRepForCachingDisplayInRect:view.bounds];
      [view cacheDisplayInRect:view.bounds toBitmapImageRep:image];
      [[image representationUsingType:NSBitmapImageFileTypePNG
                           properties:@{}] writeToFile:snapshot atomically:YES];
      finish(view, NO);
    }
    if (replay != nil && gLassoMode)
      finish(view, NO);
    if (listen) {
      dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        char buffer[256];
        while (read(STDIN_FILENO, buffer, sizeof buffer) > 0) {
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          finish(view, NO);
        });
      });
    }
    signal(SIGTERM, SIG_IGN);
    dispatch_source_t term = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(term, ^{
      finish(view, NO);
    });
    dispatch_resume(term);
    [app run];
  }
  return 0;
}
