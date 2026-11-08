// opencua-surface: an agent-owned window that shows one web page on the
// person's desktop.
//
// opencua launches it, records its pid and start time, and then lets its agents
// deliver pointer events to this process only (never to the person's own apps,
// mouse or keyboard focus). The window is shown without activating the app, so
// the person's frontmost app keeps focus. Each delivered mouse event carries
// its agent's cursor id in the event source user data; the window draws that
// agent's arrow and name where the event actually landed, so the cursors on
// screen are the real input, not an animation.
//
// Many agents can share one surface, each with its own cursor. The page sees a
// single mouse, so the window merges their input into one valid stream: when a
// different cursor needs the button it ends the current press where it was,
// re-applies that cursor's own tool and color picks (its context clicks) when
// another cursor changed them, and presses again where that cursor was, so
// every cursor's stroke continues without waiting for the others to finish.
//
// With --multi-pointer the window does not merge anything: each cursor gets
// its own pointer (its own pointerId) in the page, so presses and drags of
// different cursors are down at the same time. macOS gives a web page one
// mouse (tablet events of different devices still arrive as pointerId 1), so
// these pointers are page PointerEvents of type "pen"; a page must handle
// pointer events to use them.
//
// usage: opencua-surface <url> <title> <x,y,width,height in top-left screen
// points> [cursor-names.json] [--multi-pointer]
//        opencua-surface --self-test

#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <errno.h>
#include <fcntl.h>
#import <objc/message.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static NSString *gNamesPath = nil;

@interface SurfaceWebView : WKWebView
@end

@implementation SurfaceWebView
// The window is never key, so without this the first click of every agent
// stroke would only focus the view.
- (BOOL)acceptsFirstMouse:(NSEvent *)event {
  return YES;
}
@end

typedef NS_ENUM(NSInteger, MuxKind) {
  MuxDown,
  MuxDrag,
  MuxUp,
  MuxMove,
};

static const NSUInteger kMaxContextClicks = 4;
// How long a cursor keeps the page's one mouse, stroke after stroke, before a
// waiting cursor gets it. A stroke is never cut: the mouse changes hands only
// between strokes, so a cursor's picks are re-applied about once per slice.
static const NSTimeInterval kSlice = 1.0;
// A holder whose press has had no input for this long is treated as stuck.
static const NSTimeInterval kStuck = 0.5;
// A holder with no input for this long gives the mouse up to a waiting cursor.
static const NSTimeInterval kIdle = 0.04;
// Pages read two presses on the same spot within this time as a double click,
// so a cursor's pick is re-applied only once this has passed since it was hit.
// Measured on this side; the page reads its own clock and can fall behind
// under load, so the margin is wide.
static const NSTimeInterval kDoubleClick = 1.0;
// With paced input, a press the page has not reported within this time no
// longer holds the next one back, so a page that never answers cannot stall.
static const NSTimeInterval kAckTimeout = 2.0;
// Picks in one row band (a palette, a toolbar) or one narrow column (a tool
// column) are alternatives: pressing one undoes another.
static BOOL Alternatives(NSPoint a, NSPoint b) {
  CGFloat dx = fabs(a.x - b.x);
  CGFloat dy = fabs(a.y - b.y);
  return dy <= 24 || (dx <= 30 && dy <= 200);
}

@interface MuxEvent : NSObject
@property(nonatomic) MuxKind kind;
@property(nonatomic) NSPoint point;
@property(nonatomic) BOOL context;
// When the cursor sent it.
@property(nonatomic) NSTimeInterval arrived;
@end

@implementation MuxEvent
@end

@interface MuxCursor : NSObject
@property(nonatomic) NSPoint last;
@property(nonatomic) BOOL hasLast;
@property(nonatomic) NSTimeInterval seen;
@property(nonatomic, strong) NSMutableArray<NSValue *> *context;
@property(nonatomic, strong) NSMutableArray<MuxEvent *> *pending;
// The press of a pick already in effect was not sent, so neither is its
// release.
@property(nonatomic) BOOL swallowUp;
// How long after it was sent each of this cursor's events goes to the page: a
// cursor that waited for the mouse replays its input from when it got the
// mouse, with the spacing it was sent with, so its curves stay curves.
@property(nonatomic) NSTimeInterval shift;
@end

@implementation MuxCursor
@end

// Merges the pointer streams of many cursors into the one stream a page can
// take. A cursor holds the stream for a short slice while the others' input
// waits in order; then the next waiting cursor takes over: the current press
// ends where it was, that cursor's own picks are re-applied if another cursor
// changed them, and its press resumes where it was. Pure state with explicit
// times, so --self-test can check it without a window.
@interface CursorMux : NSObject
@property(nonatomic, copy) void (^emit)(MuxKind kind, NSPoint point);
- (void)cursor:(int64_t)tag
          kind:(MuxKind)kind
            at:(NSPoint)point
       context:(BOOL)context
           now:(NSTimeInterval)now;
- (void)pump:(NSTimeInterval)now;
// The page reported that it handled a press (down) or release at this point.
- (void)acked:(BOOL)down at:(NSPoint)point now:(NSTimeInterval)now;
// Paced: a cursor's next press waits until the page has handled the presses
// and releases already sent, and double clicks are timed from when the page
// handled a press. A busy page then never falls behind the cursors.
@property(nonatomic) BOOL paced;
// No press held and no input waiting: pumping would change nothing.
- (BOOL)quiet;
@end

@implementation CursorMux {
  NSMutableDictionary<NSNumber *, MuxCursor *> *_cursors;
  NSMutableArray<NSNumber *> *_order;
  NSMutableArray<NSValue *> *_hitPoints;
  NSMutableArray<NSNumber *> *_hitTimes;
  NSMutableArray<NSNumber *> *_hitAcked;
  NSInteger _awaiting;
  NSTimeInterval _lastProgress;
  NSMutableArray<NSValue *> *_picks;
  int64_t _holder;
  BOOL _down;
  NSTimeInterval _sliceStart;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _cursors = [NSMutableDictionary dictionary];
    _order = [NSMutableArray array];
    _hitPoints = [NSMutableArray array];
    _hitTimes = [NSMutableArray array];
    _hitAcked = [NSMutableArray array];
    _picks = [NSMutableArray array];
  }
  return self;
}

- (BOOL)quiet {
  if (_down) {
    return NO;
  }
  for (MuxCursor *cursor in _cursors.allValues) {
    if (cursor.pending.count > 0) {
      return NO;
    }
  }
  return YES;
}

// Every pick pressed on the page, oldest first.
- (void)picked:(NSPoint)point {
  [_picks addObject:[NSValue valueWithPoint:point]];
  while (_picks.count > 64) {
    [_picks removeObjectAtIndex:0];
  }
}

// A cursor's pick must be pressed again only if a nearby alternative was
// pressed after it (or the page never saw it).
- (BOOL)undone:(NSPoint)pick {
  for (NSInteger index = (NSInteger)_picks.count - 1; index >= 0; index -= 1) {
    NSPoint other = _picks[(NSUInteger)index].pointValue;
    CGFloat distance = hypot(other.x - pick.x, other.y - pick.y);
    if (distance < 3) {
      return NO;
    }
    if (Alternatives(other, pick)) {
      return YES;
    }
  }
  return YES;
}

- (NSArray<NSValue *> *)undonePicksOf:(MuxCursor *)cursor {
  NSMutableArray<NSValue *> *undone = [NSMutableArray array];
  for (NSValue *value in cursor.context) {
    if ([self undone:value.pointValue]) {
      [undone addObject:value];
    }
  }
  return undone;
}

- (MuxCursor *)cursorFor:(int64_t)tag {
  MuxCursor *cursor = _cursors[@(tag)];
  if (cursor == nil) {
    cursor = [MuxCursor new];
    cursor.context = [NSMutableArray array];
    cursor.pending = [NSMutableArray array];
    _cursors[@(tag)] = cursor;
    [_order addObject:@(tag)];
  }
  return cursor;
}

// Presses this close are on the same control: two cursors aim at a swatch or
// tool a pixel or two apart.
static const CGFloat kSameSpot = 7;

- (void)send:(MuxKind)kind at:(NSPoint)point now:(NSTimeInterval)now {
  if (self.paced && (kind == MuxDown || kind == MuxUp)) {
    _awaiting += 1;
    _lastProgress = now;
  }
  self.emit(kind, point);
}

- (void)press:(MuxKind)kind at:(NSPoint)point now:(NSTimeInterval)now {
  if (kind == MuxDown) {
    [_hitPoints addObject:[NSValue valueWithPoint:point]];
    [_hitTimes addObject:@(now)];
    [_hitAcked addObject:@(!self.paced)];
    while (_hitPoints.count > 64) {
      [_hitPoints removeObjectAtIndex:0];
      [_hitTimes removeObjectAtIndex:0];
      [_hitAcked removeObjectAtIndex:0];
    }
  }
  [self send:kind at:point now:now];
}

- (void)acked:(BOOL)down at:(NSPoint)point now:(NSTimeInterval)now {
  _awaiting = MAX(0, _awaiting - 1);
  _lastProgress = now;
  if (!down) {
    return;
  }
  for (NSUInteger index = 0; index < _hitPoints.count; index += 1) {
    NSPoint hit = _hitPoints[index].pointValue;
    if (!_hitAcked[index].boolValue &&
        hypot(hit.x - point.x, hit.y - point.y) < 4) {
      _hitTimes[index] = @(now);
      _hitAcked[index] = @YES;
      return;
    }
  }
}

// Whether the next press may go out now.
- (BOOL)ready:(NSTimeInterval)now {
  return !self.paced || _awaiting == 0 || now - _lastProgress > kAckTimeout;
}

- (void)remember:(NSPoint)point in:(MuxCursor *)cursor {
  NSIndexSet *same = [cursor.context
      indexesOfObjectsPassingTest:^BOOL(NSValue *value, NSUInteger index,
                                        BOOL *stop) {
        NSPoint old = value.pointValue;
        return fabs(old.x - point.x) < 3 && fabs(old.y - point.y) < 3;
      }];
  [cursor.context removeObjectsAtIndexes:same];
  [cursor.context addObject:[NSValue valueWithPoint:point]];
  while (cursor.context.count > kMaxContextClicks) {
    [cursor.context removeObjectAtIndex:0];
  }
}

- (void)cursor:(int64_t)tag
          kind:(MuxKind)kind
            at:(NSPoint)point
       context:(BOOL)context
           now:(NSTimeInterval)now {
  MuxCursor *cursor = [self cursorFor:tag];
  // Hover of a cursor that does not hold the mouse would only move the page's
  // one pointer away from the holder's stroke.
  if (kind == MuxMove && _holder != 0 && _holder != tag) {
    return;
  }
  MuxEvent *event = [MuxEvent new];
  event.kind = kind;
  event.point = point;
  event.context = context;
  event.arrived = now;
  if (cursor.pending.count == 0 && !(_down && _holder == tag)) {
    cursor.shift = 0;
  }
  [cursor.pending addObject:event];
  cursor.seen = now;
  [self pump:now];
}

// Whether a press on this spot now would read as a double click.
- (BOOL)hitRecently:(NSPoint)point now:(NSTimeInterval)now {
  for (NSUInteger index = 0; index < _hitPoints.count; index += 1) {
    NSPoint hit = _hitPoints[index].pointValue;
    if (hypot(hit.x - point.x, hit.y - point.y) >= kSameSpot) {
      continue;
    }
    NSTimeInterval age = now - _hitTimes[index].doubleValue;
    if (age < (_hitAcked[index].boolValue ? kDoubleClick : kAckTimeout)) {
      return YES;
    }
  }
  return NO;
}

// Whether taking the mouse now would re-apply a pick the page would read as a
// double click.
- (BOOL)canReplay:(NSArray<NSValue *> *)picks now:(NSTimeInterval)now {
  for (NSValue *value in picks) {
    if ([self hitRecently:value.pointValue now:now]) {
      return NO;
    }
  }
  return YES;
}

- (BOOL)takeOver:(int64_t)tag now:(NSTimeInterval)now {
  MuxCursor *cursor = [self cursorFor:tag];
  NSArray<NSValue *> *replay = [self undonePicksOf:cursor];
  if (![self canReplay:replay now:now]) {
    return NO;
  }
  if (_down) {
    [self send:MuxUp at:[self cursorFor:_holder].last now:now];
    _down = NO;
  }
  for (NSValue *value in replay) {
    [self press:MuxDown at:value.pointValue now:now];
    [self send:MuxUp at:value.pointValue now:now];
    [self picked:value.pointValue];
  }
  _holder = tag;
  _sliceStart = now;
  cursor.shift = MAX(0, now - cursor.pending.firstObject.arrived);
  return YES;
}

- (void)deliver:(MuxEvent *)event for:(int64_t)tag now:(NSTimeInterval)now {
  MuxCursor *cursor = [self cursorFor:tag];
  // A pick the page already has (another cursor chose the same swatch or tool)
  // is only remembered for this cursor: pressing it again changes nothing and
  // a page may read it as a double click.
  if (event.kind == MuxDown && event.context && ![self undone:event.point]) {
    [self remember:event.point in:cursor];
    cursor.swallowUp = YES;
    cursor.last = event.point;
    cursor.hasLast = YES;
    return;
  }
  if (event.kind == MuxUp && cursor.swallowUp) {
    cursor.swallowUp = NO;
    cursor.last = event.point;
    cursor.hasLast = YES;
    return;
  }
  if (event.kind == MuxDown || event.kind == MuxDrag) {
    if (!_down && event.kind == MuxDrag) {
      [self press:MuxDown
               at:(cursor.hasLast ? cursor.last : event.point)now:now];
    }
    _down = YES;
    if (event.kind == MuxDown) {
      [self press:MuxDown at:event.point now:now];
    } else {
      [self send:MuxDrag at:event.point now:now];
    }
    if (event.kind == MuxDown && event.context) {
      [self remember:event.point in:cursor];
      [self picked:event.point];
    }
  } else if (event.kind == MuxUp) {
    if (_down) {
      [self send:MuxUp at:event.point now:now];
      _down = NO;
    }
  } else {
    [self send:MuxMove at:event.point now:now];
  }
  cursor.last = event.point;
  cursor.hasLast = YES;
}

// A pick on a spot pressed within the double-click time would open whatever
// the page shows on a double click (JS Paint: Edit Colors), so it waits.
- (BOOL)mustWait:(MuxCursor *)cursor now:(NSTimeInterval)now {
  MuxEvent *event = cursor.pending.firstObject;
  if (event == nil || event.kind != MuxDown || !event.context ||
      ![self undone:event.point]) {
    return NO;
  }
  return [self hitRecently:event.point now:now];
}

// Whether the cursor's next event is due on the page.
- (BOOL)due:(MuxCursor *)cursor now:(NSTimeInterval)now {
  MuxEvent *event = cursor.pending.firstObject;
  return event != nil && event.arrived + cursor.shift <= now + 1e-9;
}

- (BOOL)othersWaitingBesides:(int64_t)tag {
  for (NSNumber *key in _order) {
    if (key.longLongValue != tag && _cursors[key].pending.count > 0) {
      return YES;
    }
  }
  return NO;
}

// A waiting cursor's picks that the page already has need no mouse: they are
// taken in place, so the holder's stroke is not cut for them.
- (void)absorbPicksInEffect:(NSTimeInterval)now {
  for (NSNumber *key in _order) {
    if (key.longLongValue == _holder) {
      continue;
    }
    MuxCursor *cursor = _cursors[key];
    for (;;) {
      MuxEvent *event = cursor.pending.firstObject;
      BOOL inEffect = event != nil && event.kind == MuxDown && event.context &&
                      ![self undone:event.point];
      BOOL release = event != nil && event.kind == MuxUp && cursor.swallowUp;
      if (!inEffect && !release) {
        break;
      }
      [cursor.pending removeObjectAtIndex:0];
      [self deliver:event for:key.longLongValue now:now];
    }
  }
}

- (void)pump:(NSTimeInterval)now {
  [self absorbPicksInEffect:now];
  for (;;) {
    if (![self ready:now]) {
      // Only the press already going on may continue: its drags and release.
      MuxCursor *current = _holder == 0 ? nil : _cursors[@(_holder)];
      MuxEvent *next = current.pending.firstObject;
      if (_down && next != nil &&
          (next.kind == MuxDrag || next.kind == MuxUp) &&
          [self due:current now:now]) {
        [current.pending removeObjectAtIndex:0];
        [self deliver:next for:_holder now:now];
        continue;
      }
      return;
    }
    MuxCursor *holder = _holder == 0 ? nil : _cursors[@(_holder)];
    BOOL others = [self othersWaitingBesides:_holder];
    BOOL keep = holder != nil &&
                (!others || (_down && holder.pending.count > 0) ||
                 (_down && now - holder.seen < kStuck) ||
                 (now - _sliceStart < kSlice &&
                  (holder.pending.count > 0 || now - holder.seen < kIdle)));
    BOOL holderWaits = holder != nil && [self mustWait:holder now:now];
    if (keep && !holderWaits) {
      if (![self due:holder now:now]) {
        return;
      }
      MuxEvent *event = holder.pending.firstObject;
      [holder.pending removeObjectAtIndex:0];
      [self deliver:event for:_holder now:now];
      continue;
    }
    // Round robin from the cursor after the holder.
    NSUInteger start = 0;
    if (_holder != 0) {
      NSUInteger index = [_order indexOfObject:@(_holder)];
      start = index == NSNotFound ? 0 : index + 1;
    }
    BOOL switched = NO;
    for (NSUInteger step = 0; step < _order.count; step += 1) {
      NSNumber *key = _order[(start + step) % _order.count];
      if (key.longLongValue == _holder || _cursors[key].pending.count == 0 ||
          [self mustWait:_cursors[key] now:now]) {
        continue;
      }
      if ([self takeOver:key.longLongValue now:now]) {
        switched = YES;
        break;
      }
    }
    if (!switched) {
      if (holder != nil && !holderWaits && [self due:holder now:now]) {
        MuxEvent *event = holder.pending.firstObject;
        [holder.pending removeObjectAtIndex:0];
        [self deliver:event for:_holder now:now];
        continue;
      }
      return;
    }
  }
}
@end

// One line of the agent pointer channel: "<tag> <context> <kind> <x> <y>",
// kind D, G, U or M (down, drag, up, move), x and y in window points from the
// window's top-left corner.
static BOOL ParseAgentLine(const char *line, int64_t *tag, BOOL *context,
                           MuxKind *kind, NSPoint *topLeft) {
  long long value = 0;
  int flag = 0;
  char letter = 0;
  double x = 0;
  double y = 0;
  if (sscanf(line, "%lld %d %c %lf %lf", &value, &flag, &letter, &x, &y) != 5) {
    return NO;
  }
  const char *kinds = "DGUM";
  const char *found = letter == 0 ? NULL : strchr(kinds, letter);
  if (value <= 0 || value > 0xffffffffLL || found == NULL || !isfinite(x) ||
      !isfinite(y)) {
    return NO;
  }
  *tag = value;
  *context = flag == 1;
  *kind = (MuxKind)(found - kinds);
  *topLeft = NSMakePoint(x, y);
  return YES;
}

// Agent pointer input sent straight to this process over a Unix socket. The
// window server merges consecutive drag events posted to one app, which mixes
// one cursor's tag with another cursor's position; this channel keeps every
// cursor's events whole and in order.
@interface AgentChannel : NSObject
- (BOOL)listenAt:(NSString *)path
         deliver:(void (^)(int64_t tag, BOOL context, MuxKind kind,
                           NSPoint topLeft))deliver;
@end

@implementation AgentChannel {
  dispatch_source_t _accept;
  NSMutableSet *_clients;
  void (^_deliver)(int64_t, BOOL, MuxKind, NSPoint);
}

- (BOOL)listenAt:(NSString *)path
         deliver:(void (^)(int64_t, BOOL, MuxKind, NSPoint))deliver {
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  const char *file = path.fileSystemRepresentation;
  if (strlen(file) >= sizeof(address.sun_path)) {
    return NO;
  }
  strlcpy(address.sun_path, file, sizeof(address.sun_path));
  int listener = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener < 0) {
    return NO;
  }
  unlink(address.sun_path);
  mode_t previous = umask(0077);
  int bound = bind(listener, (struct sockaddr *)&address, sizeof(address));
  umask(previous);
  if (bound != 0 || listen(listener, 16) != 0) {
    close(listener);
    return NO;
  }
  fcntl(listener, F_SETFL, O_NONBLOCK);
  _deliver = [deliver copy];
  _clients = [NSMutableSet set];
  _accept =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)listener, 0,
                             dispatch_get_main_queue());
  __weak AgentChannel *weakSelf = self;
  dispatch_source_set_event_handler(_accept, ^{
    int client = accept(listener, NULL, NULL);
    if (client >= 0) {
      [weakSelf readFrom:client];
    }
  });
  dispatch_resume(_accept);
  return YES;
}

- (void)readFrom:(int)client {
  fcntl(client, F_SETFL, O_NONBLOCK);
  NSMutableData *buffer = [NSMutableData data];
  dispatch_source_t source =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)client, 0,
                             dispatch_get_main_queue());
  __weak AgentChannel *weakSelf = self;
  __weak dispatch_source_t weakSource = source;
  dispatch_source_set_event_handler(source, ^{
    char chunk[8192];
    ssize_t count = read(client, chunk, sizeof(chunk));
    if (count < 0 && errno == EAGAIN) {
      return;
    }
    if (count <= 0) {
      dispatch_source_t ended = weakSource;
      if (ended != nil) {
        dispatch_source_cancel(ended);
      }
      return;
    }
    [buffer appendBytes:chunk length:(NSUInteger)count];
    [weakSelf drain:buffer];
  });
  dispatch_source_set_cancel_handler(source, ^{
    close(client);
    AgentChannel *strongSelf = weakSelf;
    dispatch_source_t ended = weakSource;
    if (strongSelf != nil && ended != nil) {
      [strongSelf->_clients removeObject:ended];
    }
  });
  [_clients addObject:source];
  dispatch_resume(source);
}

- (void)drain:(NSMutableData *)buffer {
  const char *bytes = buffer.bytes;
  NSUInteger start = 0;
  for (NSUInteger index = 0; index < buffer.length; index += 1) {
    if (bytes[index] != '\n') {
      continue;
    }
    NSUInteger length = MIN(index - start, (NSUInteger)255);
    char line[256];
    memcpy(line, bytes + start, length);
    line[length] = 0;
    int64_t tag = 0;
    BOOL context = NO;
    MuxKind kind = MuxMove;
    NSPoint point = NSZeroPoint;
    if (ParseAgentLine(line, &tag, &context, &kind, &point)) {
      _deliver(tag, context, kind, point);
    }
    start = index + 1;
  }
  [buffer replaceBytesInRange:NSMakeRange(0, start) withBytes:NULL length:0];
  if (buffer.length > 4096) {
    [buffer setLength:0];
  }
}
@end

static AgentChannel *gAgentChannel;

// Tells the window each time its page handled a press or a release, so the
// cursors' input never runs ahead of a busy page. It only reports; it does not
// change what the page does with the input.
static NSString *const kPageAckScript =
    @"(function(){function r(k,e){try{webkit.messageHandlers.opencuaInput."
    @"postMessage([k,e.clientX,e.clientY]);}catch(_){}}"
    @"addEventListener('pointerdown',function(e){r('d',e);},true);"
    @"addEventListener('pointerup',function(e){r('u',e);},true);})();";

// --multi-pointer: one page pointer per cursor. Each cursor's press, drags and
// release go to the element under its own point (moves while pressed stay on
// the pressed element, like implicit capture). Pointer capture calls on these
// pointers are accepted as no-ops instead of throwing for an unknown id.
static NSString *const kMultiPointerScript =
    @"(function(){var S=new Map(),own=new Set(),P=Element.prototype;"
    @"['setPointerCapture','releasePointerCapture'].forEach(function(n){"
    @"var f=P[n];P[n]=function(id){if(own.has(id))return;return "
    @"f.call(this,id);};});"
    @"var "
    @"h=P.hasPointerCapture;P.hasPointerCapture=function(id){if(own.has(id)){"
    @"var s=S.get(id);return !!(s&&s.t===this);}return h.call(this,id);};"
    @"function fire(type,t,id,x,y,down,button){t.dispatchEvent(new "
    @"PointerEvent(type,"
    @"{pointerId:id,pointerType:'pen',isPrimary:false,clientX:x,clientY:y,"
    @"screenX:x,"
    @"screenY:y,button:button,buttons:down?1:0,pressure:down?0.5:0,width:1,"
    @"height:1,"
    @"bubbles:true,cancelable:true,composed:true,view:window}));}"
    @"window.__opencuaPointers=function(batch){for(var i=0;i<batch.length;i++){"
    @"var "
    @"e=batch[i],id=1000+(e[0]%2000000000),k=e[1],x=e[2],y=e[3];own.add(id);"
    @"if(typeof e[4]==='string')(window.__opencuaPointerColors||"
    @"(window.__opencuaPointerColors={}))[id]=e[4];"
    @"var s=S.get(id);if(!s){s={t:null,down:false};S.set(id,s);}"
    @"var hit=document.elementFromPoint(x,y)||document.documentElement;"
    @"if(k==='D'){if(s.down&&s.t)fire('pointerup',s.t,id,x,y,false,0);"
    @"s.t=hit;s.down=true;fire('pointerdown',hit,id,x,y,true,0);}"
    @"else if(k==='U'){var t=s.down&&s.t?s.t:hit;s.down=false;s.t=null;"
    @"fire('pointerup',t,id,x,y,false,0);}"
    @"else{fire('pointermove',s.down&&s.t?s.t:hit,id,x,y,s.down,-1);}}};})();";

@interface PageAck : NSObject <WKScriptMessageHandler>
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic, weak) WKWebView *web;
@property(nonatomic, copy) void (^handled)(BOOL down, NSPoint location);
@end

@implementation PageAck
- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message {
  NSArray *body =
      [message.body isKindOfClass:NSArray.class] ? message.body : nil;
  WKWebView *web = self.web;
  if (body.count != 3 || web == nil ||
      ![body[1] isKindOfClass:NSNumber.class] ||
      ![body[2] isKindOfClass:NSNumber.class]) {
    return;
  }
  NSPoint client = NSMakePoint([body[1] doubleValue], [body[2] doubleValue]);
  NSPoint location = [web convertPoint:client toView:nil];
  self.handled([body[0] isEqual:@"d"], location);
}
@end

@interface CursorMark : NSObject
@property(nonatomic) NSPoint point;
@property(nonatomic) NSTimeInterval seen;
@property(nonatomic) BOOL down;
@end

@implementation CursorMark
@end

@interface CursorLayerView : NSView
@property(nonatomic, strong)
    NSMutableDictionary<NSNumber *, CursorMark *> *marks;
@property(nonatomic, strong) NSDictionary *names;
@end

@implementation CursorLayerView
- (BOOL)isFlipped {
  return NO;
}

- (NSView *)hitTest:(NSPoint)point {
  return nil;
}

static NSColor *ColorFromHex(NSString *hex) {
  unsigned int value = 0xffffff;
  if (hex.length == 7) {
    [[NSScanner scannerWithString:[hex substringFromIndex:1]]
        scanHexInt:&value];
  }
  return [NSColor colorWithRed:((value >> 16) & 255) / 255.0
                         green:((value >> 8) & 255) / 255.0
                          blue:(value & 255) / 255.0
                         alpha:1];
}

- (void)drawRect:(NSRect)dirty {
  for (NSNumber *key in self.marks) {
    CursorMark *mark = self.marks[key];
    NSDictionary *entry = self.names[key.stringValue];
    NSString *name = [entry[@"name"] isKindOfClass:NSString.class]
                         ? entry[@"name"]
                         : [NSString stringWithFormat:@"cursor %@", key];
    NSColor *color = ColorFromHex([entry[@"color"] isKindOfClass:NSString.class]
                                      ? entry[@"color"]
                                      : @"#ffffff");
    NSPoint p = mark.point;
    NSBezierPath *arrow = [NSBezierPath bezierPath];
    [arrow moveToPoint:p];
    [arrow lineToPoint:NSMakePoint(p.x, p.y - 16)];
    [arrow lineToPoint:NSMakePoint(p.x + 4.5, p.y - 12)];
    [arrow lineToPoint:NSMakePoint(p.x + 11, p.y - 12)];
    [arrow closePath];
    [color setFill];
    [arrow fill];
    [NSColor.blackColor setStroke];
    arrow.lineWidth = mark.down ? 2 : 1;
    [arrow stroke];
    NSDictionary *attributes = @{
      NSFontAttributeName : [NSFont systemFontOfSize:9 weight:NSFontWeightBold],
      NSForegroundColorAttributeName : NSColor.blackColor
    };
    NSSize size = [name sizeWithAttributes:attributes];
    NSRect box = NSMakeRect(p.x + 10, p.y - 13 - size.height, size.width + 6,
                            size.height + 1);
    // Near the right edge the label goes left of the arrow, so a cursor's name
    // and purpose stay readable wherever it works.
    if (NSMaxX(box) > NSWidth(self.bounds) && p.x - 4 - box.size.width >= 0) {
      box.origin.x = p.x - 4 - box.size.width;
    }
    [[color colorWithAlphaComponent:0.9] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:box xRadius:3 yRadius:3] fill];
    [name drawAtPoint:NSMakePoint(box.origin.x + 3, box.origin.y)
        withAttributes:attributes];
  }
}
@end

@interface SurfaceWindow : NSWindow
@property(nonatomic, weak) CursorLayerView *cursorLayer;
@property(nonatomic, strong) CursorMux *mux;
- (void)agent:(int64_t)owner
         kind:(MuxKind)kind
           at:(NSPoint)location
      context:(BOOL)context;
@property(nonatomic) BOOL paced;
@property(nonatomic) BOOL multiPointer;
@property(nonatomic, weak) WKWebView *web;
@property(nonatomic, strong) NSTimer *pumpTimer;
@property(nonatomic, strong) NSMutableArray<NSArray *> *pointerBatch;
- (void)pageHandled:(BOOL)down at:(NSPoint)location;
@end

@implementation SurfaceWindow
// Agent events carry a nonzero source user data tag and draw that agent's
// cursor. The window sits one level below normal windows, so agent input can
// never bring it over the person's work; the person's own click raises it.
- (void)sendEvent:(NSEvent *)event {
  NSEventType type = event.type;
  BOOL pointer =
      type == NSEventTypeLeftMouseDown || type == NSEventTypeLeftMouseDragged ||
      type == NSEventTypeLeftMouseUp || type == NSEventTypeMouseMoved;
  CGEventRef cg = pointer ? event.CGEvent : NULL;
  int64_t data =
      cg == NULL ? 0 : CGEventGetIntegerValueField(cg, kCGEventSourceUserData);
  // Low 32 bits: the agent's cursor tag. Bit 32: a context click (tool, size
  // or color pick) to re-apply for that cursor after another cursor cut in.
  int64_t owner = data & 0xffffffff;
  BOOL context = ((data >> 32) & 1) == 1;
  if (owner == 0) {
    // The person clicked it: from now on it is an ordinary window they chose to
    // look at.
    if (type == NSEventTypeLeftMouseDown && self.level < NSNormalWindowLevel) {
      self.level = NSNormalWindowLevel;
    }
    [super sendEvent:event];
    return;
  }
  MuxKind kind = type == NSEventTypeLeftMouseDown      ? MuxDown
                 : type == NSEventTypeLeftMouseDragged ? MuxDrag
                 : type == NSEventTypeLeftMouseUp      ? MuxUp
                                                       : MuxMove;
  [self agent:owner kind:kind at:event.locationInWindow context:context];
}

- (void)pageHandled:(BOOL)down at:(NSPoint)location {
  [self.mux acked:down at:location now:NSProcessInfo.processInfo.systemUptime];
}

// Draws the agent's cursor where its input landed and merges that input with
// every other cursor's into the page's one mouse.
- (void)agent:(int64_t)owner
         kind:(MuxKind)kind
           at:(NSPoint)location
      context:(BOOL)context {
  if (self.cursorLayer != nil) {
    NSNumber *key = @(owner);
    CursorMark *mark = self.cursorLayer.marks[key] ?: [CursorMark new];
    mark.point = [self.cursorLayer convertPoint:location fromView:nil];
    mark.seen = NSDate.timeIntervalSinceReferenceDate;
    mark.down = kind == MuxDown || kind == MuxDrag;
    self.cursorLayer.marks[key] = mark;
    self.cursorLayer.needsDisplay = YES;
  }
  if (self.multiPointer) {
    [self queuePointer:owner kind:kind at:location];
    return;
  }
  if (self.mux == nil) {
    self.mux = [CursorMux new];
    self.mux.paced = self.paced;
    __weak SurfaceWindow *weakSelf = self;
    self.mux.emit = ^(MuxKind merged, NSPoint point) {
      [weakSelf deliver:merged at:point];
    };
  }
  [self.mux cursor:owner
              kind:kind
                at:location
           context:context
               now:NSProcessInfo.processInfo.systemUptime];
  [self keepPumping];
}

// Waiting cursors get the mouse when the holder's slice ends, even if no new
// input arrives to trigger it. The timer runs only while a press is held or
// input waits, so an idle surface costs no CPU.
- (void)keepPumping {
  if (self.pumpTimer != nil || [self.mux quiet]) {
    return;
  }
  __weak SurfaceWindow *weakSelf = self;
  self.pumpTimer = [NSTimer
      scheduledTimerWithTimeInterval:0.008
                             repeats:YES
                               block:^(NSTimer *timer) {
                                 SurfaceWindow *surface = weakSelf;
                                 if (surface == nil) {
                                   [timer invalidate];
                                   return;
                                 }
                                 [surface.mux pump:NSProcessInfo.processInfo
                                                       .systemUptime];
                                 if ([surface.mux quiet]) {
                                   [timer invalidate];
                                   surface.pumpTimer = nil;
                                 }
                               }];
}

// Queues one cursor's event for its own page pointer; all events that arrive
// before the main queue turns go to the page in one script call, in order.
- (void)queuePointer:(int64_t)owner kind:(MuxKind)kind at:(NSPoint)location {
  WKWebView *web = self.web;
  if (web == nil) {
    return;
  }
  NSPoint client = [web convertPoint:location fromView:nil];
  NSString *code = kind == MuxDown   ? @"D"
                   : kind == MuxDrag ? @"G"
                   : kind == MuxUp   ? @"U"
                                     : @"M";
  if (self.pointerBatch == nil) {
    self.pointerBatch = [NSMutableArray array];
  }
  // The cursor's label color travels with its events, so a page can draw in
  // the same color the cursor is labeled with. A cursor new since the last
  // once-a-second names poll reads the file now, so its first stroke has it.
  NSString *ownerKey = @(owner).stringValue;
  if (self.cursorLayer != nil && self.cursorLayer.names[ownerKey] == nil &&
      gNamesPath != nil) {
    NSData *data = [NSData dataWithContentsOfFile:gNamesPath];
    id parsed = data == nil ? nil
                            : [NSJSONSerialization JSONObjectWithData:data
                                                              options:0
                                                                error:NULL];
    if ([parsed isKindOfClass:NSDictionary.class]) {
      self.cursorLayer.names = parsed;
      self.cursorLayer.needsDisplay = YES;
    }
  }
  id color = self.cursorLayer.names[ownerKey][@"color"];
  [self.pointerBatch
      addObject:[color isKindOfClass:NSString.class]
                    ? @[ @(owner), code, @(client.x), @(client.y), color ]
                    : @[ @(owner), code, @(client.x), @(client.y) ]];
  if (self.pointerBatch.count > 1) {
    return;
  }
  __weak SurfaceWindow *weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    [weakSelf flushPointers];
  });
}

- (void)flushPointers {
  NSArray *batch = self.pointerBatch;
  self.pointerBatch = nil;
  WKWebView *web = self.web;
  if (batch.count == 0 || web == nil) {
    return;
  }
  NSData *json = [NSJSONSerialization dataWithJSONObject:batch
                                                 options:0
                                                   error:NULL];
  if (json == nil) {
    return;
  }
  NSString *call = [NSString
      stringWithFormat:
          @"window.__opencuaPointers&&window.__opencuaPointers(%@)",
          [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]];
  [web evaluateJavaScript:call completionHandler:nil];
}

- (void)deliver:(MuxKind)kind at:(NSPoint)point {
  NSEventType type = kind == MuxDown   ? NSEventTypeLeftMouseDown
                     : kind == MuxDrag ? NSEventTypeLeftMouseDragged
                     : kind == MuxUp   ? NSEventTypeLeftMouseUp
                                       : NSEventTypeMouseMoved;
  NSEvent *merged =
      [NSEvent mouseEventWithType:type
                         location:point
                    modifierFlags:0
                        timestamp:NSProcessInfo.processInfo.systemUptime
                     windowNumber:self.windowNumber
                          context:nil
                      eventNumber:0
                       clickCount:1
                         pressure:(kind == MuxDown || kind == MuxDrag) ? 1 : 0];
  [super sendEvent:merged];
}

- (BOOL)canBecomeKeyWindow {
  return NO;
}
@end

// Generated-case property test (seeded, not coverage guided): 2 to 4 cursors,
// each in its own region of the page, draw strokes at the same time on one
// surface. Every cursor's stroke must reach the page whole (same points, same
// order, never cut by another cursor) and with the spacing it was sent with,
// however long that cursor waited for the mouse. Returns NO and says why on a
// violation.
typedef struct {
  NSTimeInterval t;
  int64_t tag;
  MuxKind kind;
  CGFloat x;
  CGFloat y;
} FuzzEvent;

static const NSUInteger kFuzzMax = 1024;

static uint32_t FuzzNext(uint32_t *state) {
  *state ^= *state << 13;
  *state ^= *state >> 17;
  *state ^= *state << 5;
  return *state;
}

static double FuzzUniform(uint32_t *state, double low, double high) {
  return low + (high - low) * (FuzzNext(state) % 1000000) / 1000000.0;
}

static BOOL FuzzWaypointReplay(uint32_t seed, char *why, size_t whySize) {
  uint32_t state = seed * 2654435761u + 1;
  FuzzEvent *in = calloc(kFuzzMax, sizeof(FuzzEvent));
  FuzzEvent *out = calloc(kFuzzMax, sizeof(FuzzEvent));
  __block NSUInteger outCount = 0;
  __block NSTimeInterval clock = 0;
  NSUInteger inCount = 0;
  int cursors = 2 + (int)(FuzzNext(&state) % 3);
  for (int cursor = 1; cursor <= cursors; cursor += 1) {
    NSTimeInterval t = FuzzUniform(&state, 0, 0.3);
    int strokes = 1 + (int)(FuzzNext(&state) % 3);
    for (int stroke = 0; stroke < strokes; stroke += 1) {
      int points = 2 + (int)(FuzzNext(&state) % 11);
      for (int point = 0; point < points; point += 1) {
        MuxKind kind = point == 0 ? MuxDown : MuxDrag;
        in[inCount++] =
            (FuzzEvent){t, cursor, kind, cursor * 1000 + stroke * 100 + point,
                        (CGFloat)(FuzzNext(&state) % 500)};
        if (point == points - 1) {
          in[inCount] = in[inCount - 1];
          in[inCount].kind = MuxUp;
          in[inCount].t = t + FuzzUniform(&state, 0.004, 0.03);
          t = in[inCount].t;
          inCount += 1;
        } else {
          t += FuzzUniform(&state, 0.004, 0.03);
        }
      }
      t += FuzzUniform(&state, 0.02, 0.2);
    }
  }
  // Feed in arrival order (stable per cursor), pumping every 8 ms like the
  // window's timer.
  NSUInteger *order = calloc(inCount, sizeof(NSUInteger));
  for (NSUInteger index = 0; index < inCount; index += 1) {
    order[index] = index;
  }
  for (NSUInteger a = 1; a < inCount; a += 1) {
    for (NSUInteger b = a; b > 0 && in[order[b]].t < in[order[b - 1]].t;
         b -= 1) {
      NSUInteger swap = order[b];
      order[b] = order[b - 1];
      order[b - 1] = swap;
    }
  }
  CursorMux *mux = [CursorMux new];
  mux.emit = ^(MuxKind kind, NSPoint point) {
    if (outCount < kFuzzMax) {
      out[outCount++] =
          (FuzzEvent){clock, (int64_t)(point.x / 1000), kind, point.x, point.y};
    }
  };
  NSUInteger fed = 0;
  NSTimeInterval tick = 0;
  BOOL ok = YES;
  while (fed < inCount || ![mux quiet]) {
    if (tick > 30) {
      snprintf(why, whySize, "stalled: input still waiting after 30 s");
      ok = NO;
      break;
    }
    if (fed < inCount && in[order[fed]].t <= tick) {
      FuzzEvent event = in[order[fed++]];
      clock = event.t;
      [mux cursor:event.tag
             kind:event.kind
               at:NSMakePoint(event.x, event.y)
          context:NO
              now:clock];
    } else {
      clock = tick;
      [mux pump:clock];
      tick += 0.008;
    }
  }
  // Same points in the same order per cursor, with the sent spacing.
  for (int cursor = 1; ok && cursor <= cursors; cursor += 1) {
    NSUInteger i = 0;
    NSUInteger o = 0;
    NSUInteger previousIn = 0;
    NSUInteger previousOut = 0;
    for (;;) {
      while (i < inCount && in[i].tag != cursor) {
        i += 1;
      }
      while (o < outCount && out[o].tag != cursor) {
        o += 1;
      }
      if (i >= inCount || o >= outCount) {
        if (i < inCount || o < outCount) {
          snprintf(why, whySize, "cursor %d: %s", cursor,
                   i < inCount ? "input lost" : "extra output");
          ok = NO;
        }
        break;
      }
      if (in[i].kind != out[o].kind || in[i].x != out[o].x ||
          in[i].y != out[o].y) {
        snprintf(why, whySize,
                 "cursor %d: sent %d %.0f,%.0f, page got %d %.0f,%.0f", cursor,
                 (int)in[i].kind, in[i].x, in[i].y, (int)out[o].kind, out[o].x,
                 out[o].y);
        ok = NO;
        break;
      }
      if (in[i].kind != MuxDown && previousOut < o) {
        double sent = in[i].t - in[previousIn].t;
        double got = out[o].t - out[previousOut].t;
        if (fabs(sent - got) > 0.0085) {
          snprintf(why, whySize,
                   "cursor %d at %.0f,%.0f: sent %.1f ms after the previous "
                   "point, page got it %.1f ms after",
                   cursor, in[i].x, in[i].y, sent * 1000, got * 1000);
          ok = NO;
          break;
        }
      }
      previousIn = i;
      previousOut = o;
      i += 1;
      o += 1;
    }
  }
  // A stroke is never cut: nothing of another cursor between a press and its
  // release.
  int64_t pressing = 0;
  for (NSUInteger o = 0; ok && o < outCount; o += 1) {
    if (pressing != 0 && out[o].tag != pressing) {
      snprintf(why, whySize, "cursor %lld cut into cursor %lld's stroke",
               out[o].tag, pressing);
      ok = NO;
    }
    pressing = out[o].kind == MuxDown ? out[o].tag
               : out[o].kind == MuxUp ? 0
                                      : pressing;
  }
  free(order);
  free(in);
  free(out);
  return ok;
}

// Replays scripted cursor input through CursorMux at explicit times and
// compares the merged stream with what the page must receive.
static int SelfTest(void) {
  NSMutableArray<NSString *> *out = [NSMutableArray array];
  __block CursorMux *mux = [CursorMux new];
  mux.emit = ^(MuxKind kind, NSPoint point) {
    NSString *name = @[ @"D", @"G", @"U", @"M" ][kind];
    [out addObject:[NSString stringWithFormat:@"%@%.0f,%.0f", name, point.x,
                                              point.y]];
  };
  __block int failures = 0;
  void (^check)(NSString *, NSString *) = ^(NSString *label, NSString *want) {
    NSString *got = [out componentsJoinedByString:@" "];
    if (![got isEqualToString:want]) {
      failures += 1;
      fprintf(stderr, "FAIL %s\n  want: %s\n  got:  %s\n", label.UTF8String,
              want.UTF8String, got.UTF8String);
    }
    [out removeAllObjects];
  };
  void (^at)(int64_t, MuxKind, CGFloat, CGFloat, BOOL, NSTimeInterval) =
      ^(int64_t tag, MuxKind kind, CGFloat x, CGFloat y, BOOL context,
        NSTimeInterval now) {
        [mux cursor:tag kind:kind at:NSMakePoint(x, y) context:context now:now];
      };

  void (^reset)(void) = ^{
    mux = [CursorMux new];
    mux.emit = ^(MuxKind kind, NSPoint point) {
      NSString *name = @[ @"D", @"G", @"U", @"M" ][kind];
      [out addObject:[NSString stringWithFormat:@"%@%.0f,%.0f", name, point.x,
                                                point.y]];
    };
  };

  // A second cursor waits while the first one's stroke goes on, then draws.
  reset();
  at(1, MuxDown, 0, 0, NO, 0.000);
  at(2, MuxDown, 100, 100, NO, 0.001);
  at(1, MuxDrag, 10, 0, NO, 0.010);
  at(2, MuxDrag, 110, 100, NO, 0.011);
  at(1, MuxUp, 10, 0, NO, 0.020);
  at(2, MuxUp, 110, 100, NO, 0.021);
  [mux pump:0.10];
  [mux pump:0.13];
  check(@"queued strokes", @"D0,0 G10,0 U10,0 D100,100 G110,100 U110,100");

  // A stroke is never cut for a waiting cursor; it gets the mouse after.
  reset();
  at(1, MuxDown, 0, 0, NO, 0.00);
  at(1, MuxDrag, 1, 0, NO, 0.05);
  at(2, MuxDown, 50, 50, NO, 0.06);
  at(1, MuxDrag, 2, 0, NO, 0.10);
  at(1, MuxDrag, 3, 0, NO, 0.13);
  check(@"a stroke is never cut", @"D0,0 G1,0 G2,0 G3,0");
  at(1, MuxUp, 3, 0, NO, 0.20);
  [mux pump:0.30];
  check(@"the waiting cursor draws after the stroke", @"U3,0 D50,50");

  // A press that stops getting input does not hold the mouse forever.
  reset();
  at(1, MuxDown, 0, 0, NO, 0.00);
  at(2, MuxDown, 50, 50, NO, 0.10);
  [mux pump:0.40];
  check(@"a quiet press keeps the mouse a while", @"D0,0");
  [mux pump:0.60];
  check(@"a stuck press lets the next cursor in", @"U0,0 D50,50");

  // Every swatch of a palette row replaces the others, however far apart.
  reset();
  at(1, MuxDown, 41, 1317, YES, 0.00);
  at(1, MuxUp, 41, 1317, YES, 0.00);
  at(1, MuxDown, 100, 100, NO, 0.01);
  at(1, MuxUp, 100, 100, NO, 0.02);
  at(2, MuxDown, 249, 1333, YES, 0.03);
  at(2, MuxUp, 249, 1333, YES, 0.03);
  at(2, MuxDown, 200, 200, NO, 0.04);
  at(2, MuxUp, 200, 200, NO, 0.05);
  [mux pump:0.10];
  [mux pump:0.13];
  at(1, MuxDown, 110, 100, NO, 1.20);
  [mux pump:1.30];
  check(@"far swatches of one palette replace each other",
        @"D41,1317 U41,1317 D100,100 U100,100 D249,1333 U249,1333 D200,200 "
        @"U200,200 D41,1317 U41,1317 D110,100");

  // A tool every cursor shares is not pressed again, only the replaced swatch.
  reset();
  at(1, MuxDown, 40, 138, YES, 0.00);
  at(1, MuxUp, 40, 138, YES, 0.00);
  at(1, MuxDown, 73, 1333, YES, 0.00);
  at(1, MuxUp, 73, 1333, YES, 0.00);
  at(2, MuxDown, 40, 138, YES, 0.01);
  at(2, MuxUp, 40, 138, YES, 0.01);
  at(2, MuxDown, 137, 1333, YES, 0.01);
  at(2, MuxUp, 137, 1333, YES, 0.01);
  [mux pump:0.10];
  at(1, MuxDown, 500, 500, NO, 1.20);
  [mux pump:1.30];
  check(@"only replaced picks are pressed again",
        @"D40,138 U40,138 D73,1333 U73,1333 D137,1333 U137,1333 D73,1333 "
        @"U73,1333 D500,500");

  // Hover of a cursor that does not hold the mouse is not sent.
  at(2, MuxMove, 400, 400, NO, 1.40);
  check(@"hover of a waiting cursor", @"");

  // Two cursors picking the same swatch: the page already has it, so the
  // second pick is not pressed again, and that cursor draws with it.
  reset();
  at(1, MuxDown, 73, 1333, YES, 0.00);
  at(1, MuxUp, 73, 1333, YES, 0.00);
  at(1, MuxDown, 100, 100, NO, 0.01);
  at(2, MuxDown, 73, 1333, YES, 0.20);
  at(2, MuxUp, 73, 1333, YES, 0.20);
  at(1, MuxDrag, 110, 100, NO, 0.30);
  at(1, MuxUp, 110, 100, NO, 0.31);
  check(@"same pick by another cursor is not pressed again",
        @"D73,1333 U73,1333 D100,100 G110,100 U110,100");
  [mux pump:1.20];
  at(2, MuxDown, 200, 200, NO, 1.30);
  check(@"the other cursor draws with the pick in effect", @"D200,200");

  // Going back to a swatch pressed a moment ago (after another cursor picked a
  // neighbour) waits out the double-click margin, even aimed a pixel apart.
  reset();
  at(1, MuxDown, 89, 1317, YES, 0.00);
  at(1, MuxUp, 89, 1317, YES, 0.00);
  [mux pump:0.05];
  at(2, MuxDown, 105, 1317, YES, 0.06);
  at(2, MuxUp, 105, 1317, YES, 0.06);
  [mux pump:0.15];
  at(1, MuxDown, 90, 1318, YES, 0.20);
  at(1, MuxUp, 90, 1318, YES, 0.20);
  [mux pump:0.90];
  check(@"nearby pick waits out the double click",
        @"D89,1317 U89,1317 D105,1317 U105,1317");
  [mux pump:1.30];
  // Its own earlier pick is restored first, so the new one a pixel away is
  // already in effect.
  check(@"nearby pick after the double click margin", @"D89,1317 U89,1317");

  // Paced: the next press waits until the page handled the previous ones.
  reset();
  mux.paced = YES;
  at(1, MuxDown, 89, 1317, YES, 0.00);
  at(1, MuxUp, 89, 1317, YES, 0.00);
  at(1, MuxDown, 100, 100, NO, 0.01);
  at(1, MuxDrag, 110, 100, NO, 0.02);
  check(@"paced: the stroke waits for the page", @"D89,1317 U89,1317");
  [mux acked:YES at:NSMakePoint(89, 1317) now:0.60];
  [mux acked:NO at:NSMakePoint(89, 1317) now:0.61];
  [mux pump:0.62];
  check(@"paced: the stroke goes once the page caught up",
        @"D100,100 G110,100");
  at(1, MuxUp, 110, 100, NO, 0.63);
  check(@"paced: a press already going on finishes", @"U110,100");

  // Paced double clicks are timed from when the page handled the press.
  at(2, MuxDown, 105, 1317, YES, 0.70);
  at(2, MuxUp, 105, 1317, YES, 0.70);
  [mux acked:YES at:NSMakePoint(100, 100) now:0.70];
  [mux acked:NO at:NSMakePoint(110, 100) now:0.70];
  [mux pump:0.71];
  check(@"paced: the next cursor's pick", @"D105,1317 U105,1317");
  [mux acked:YES at:NSMakePoint(105, 1317) now:0.80];
  [mux acked:NO at:NSMakePoint(105, 1317) now:0.80];
  at(1, MuxDown, 200, 200, NO, 1.40);
  check(@"paced: the old pick waits a second after the page handled it", @"");
  [mux pump:1.70];
  check(@"paced: then it is re-applied", @"D89,1317 U89,1317");

  // A page that never answers does not stall the cursors.
  [mux pump:3.80];
  check(@"paced: no answer for two seconds lets input go", @"D200,200");

  // A cursor that waited for the mouse draws its stroke with the spacing it
  // sent it with, not as one burst the page joins with a straight line.
  reset();
  at(1, MuxDown, 0, 0, NO, 0.000);
  at(2, MuxDown, 100, 100, NO, 0.001);
  at(1, MuxDrag, 10, 0, NO, 0.020);
  at(2, MuxDrag, 110, 100, NO, 0.021);
  at(2, MuxDrag, 120, 110, NO, 0.041);
  at(1, MuxUp, 10, 0, NO, 0.050);
  at(2, MuxUp, 120, 110, NO, 0.061);
  [mux pump:0.10];
  check(@"waiting cursor: its press when it gets the mouse",
        @"D0,0 G10,0 U10,0 D100,100");
  [mux pump:0.115];
  check(@"waiting cursor: its next point not yet", @"");
  [mux pump:0.12];
  check(@"waiting cursor: 20 ms after its press", @"G110,100");
  [mux pump:0.14];
  check(@"waiting cursor: 20 ms after that", @"G120,110");
  [mux pump:0.16];
  check(@"waiting cursor: its release", @"U120,110");

  {
    int attempted = 0;
    int failing = 0;
    for (uint32_t seed = 1; seed <= 500; seed += 1) {
      char why[256] = {0};
      attempted += 1;
      if (!FuzzWaypointReplay(seed, why, sizeof(why))) {
        if (failing < 3) {
          fprintf(stderr, "FAIL waypoint replay seed %u: %s\n", seed, why);
        }
        failing += 1;
      }
    }
    printf(
        "waypoint replay: %d attempted, %d executed, 0 discarded, %d failing\n",
        attempted, attempted, failing);
    failures += failing;
  }

  // Lines of the agent pointer channel.
  {
    int64_t tag = 0;
    BOOL context = NO;
    MuxKind kind = MuxMove;
    NSPoint point = NSZeroPoint;
    BOOL parsed = ParseAgentLine("4294967295 1 G 12.5 300", &tag, &context,
                                 &kind, &point);
    if (!parsed || tag != 4294967295LL || !context || kind != MuxDrag ||
        point.x != 12.5 || point.y != 300) {
      failures += 1;
      fprintf(stderr, "FAIL channel line\n");
    }
    const char *bad[] = {"0 0 D 1 1", "4294967296 0 D 1 1",
                         "7 0 X 1 1", "7 0 D 1",
                         "",          "7 0 D nan 1"};
    for (size_t index = 0; index < sizeof(bad) / sizeof(bad[0]); index += 1) {
      if (ParseAgentLine(bad[index], &tag, &context, &kind, &point)) {
        failures += 1;
        fprintf(stderr, "FAIL channel accepted \"%s\"\n", bad[index]);
      }
    }
  }

  if (failures == 0) {
    printf("SELF-TEST OK\n");
  }
  return failures == 0 ? 0 : 1;
}

// The page's sound, for agents that must hear it: WebKit plays page audio in
// its own GPU process, so app-filtered audio capture cannot attribute it to this
// surface. WebKit's own playing-audio state can, and it is written as
// {"playing":bool,"changedAt":ms} next to the surface socket on every change.
@interface AudioStateWriter : NSObject <WKScriptMessageHandler>
@property(nonatomic, copy) NSString *path;
@property(nonatomic) BOOL playing;
@property(nonatomic) int64_t changedAt;
@property(nonatomic, copy) NSDictionary *level;
@property(nonatomic, weak) WKWebView *web;
@end

// WebAudio output level, measured inside the page: every AudioContext's output
// passes through one AnalyserNode on its way to the speakers, sampled four
// times a second while it is audible (and once more when it falls silent).
// Media elements are not tapped: routing them through WebAudio would silence
// cross-origin media.
static NSString *const kAudioTapScript = @"(() => {\n  const Context = window.AudioContext || window.webkitAudioContext;\n  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.opencuaAudio;\n  if (!Context || !handler || AudioNode.prototype.__opencuaTapped) return;\n  AudioNode.prototype.__opencuaTapped = true;\n  const taps = new WeakMap();\n  const live = [];\n  const connect = AudioNode.prototype.connect;\n  AudioNode.prototype.connect = function (target, output, input) {\n    const context = this.context;\n    if (context instanceof Context && target === context.destination && taps.get(context) !== this) {\n      let tap = taps.get(context);\n      if (!tap) {\n        tap = context.createAnalyser();\n        tap.fftSize = 2048;\n        connect.call(tap, context.destination);\n        taps.set(context, tap);\n        live.push(new WeakRef(tap));\n      }\n      connect.call(this, tap, output === undefined ? 0 : output);\n      return target;\n    }\n    return connect.apply(this, arguments);\n  };\n  // A page that disconnects from its destination must find the connection it made: translate it to the tap.\n  const disconnect = AudioNode.prototype.disconnect;\n  AudioNode.prototype.disconnect = function (target, output, input) {\n    const context = this.context;\n    const tap = context && taps.get(context);\n    if (tap && tap !== this && target === context.destination) {\n      return output === undefined ? disconnect.call(this, tap) : disconnect.call(this, tap, output);\n    }\n    return disconnect.apply(this, arguments);\n  };\n  const BANDS = 8;\n  let audible = false;\n  setInterval(() => {\n    let sum = 0, count = 0, peak = 0;\n    const bands = new Array(BANDS).fill(-160);\n    for (let index = live.length - 1; index >= 0; index -= 1) {\n      const tap = live[index].deref();\n      if (!tap) { live.splice(index, 1); continue; }\n      if (tap.context.state !== \"running\") continue;\n      const wave = new Float32Array(tap.fftSize);\n      tap.getFloatTimeDomainData(wave);\n      for (const sample of wave) { sum += sample * sample; count += 1; peak = Math.max(peak, Math.abs(sample)); }\n      const spectrum = new Float32Array(tap.frequencyBinCount);\n      tap.getFloatFrequencyData(spectrum);\n      const nyquist = tap.context.sampleRate / 2;\n      for (let band = 0; band < BANDS; band += 1) {\n        const low = 20 * Math.pow(nyquist / 20, band / BANDS);\n        const high = 20 * Math.pow(nyquist / 20, (band + 1) / BANDS);\n        const from = Math.floor((low / nyquist) * spectrum.length);\n        const to = Math.max(from + 1, Math.floor((high / nyquist) * spectrum.length));\n        let level = -160;\n        for (let bin = from; bin < to && bin < spectrum.length; bin += 1) level = Math.max(level, spectrum[bin]);\n        bands[band] = Math.max(bands[band], Number.isFinite(level) ? level : -160);\n      }\n    }\n    const rms = count > 0 ? Math.sqrt(sum / count) : 0;\n    const rmsDb = rms > 0 ? Math.max(-160, 20 * Math.log10(rms)) : -160;\n    const peakDb = peak > 0 ? Math.max(-160, 20 * Math.log10(peak)) : -160;\n    const now = rmsDb > -100;\n    if (now || audible) handler.postMessage({ rmsDb, peakDb, bands });\n    audible = now;\n  }, 250);\n})();";

@implementation AudioStateWriter
- (void)write:(BOOL)playing {
  self.playing = playing;
  self.changedAt = (int64_t)(NSDate.date.timeIntervalSince1970 * 1000);
  [self flush];
}
- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message {
  NSDictionary *body =
      [message.body isKindOfClass:NSDictionary.class] ? message.body : nil;
  NSNumber *rms = body[@"rmsDb"];
  NSNumber *peak = body[@"peakDb"];
  NSArray *bands = body[@"bands"];
  if (![rms isKindOfClass:NSNumber.class] ||
      ![peak isKindOfClass:NSNumber.class] ||
      ![bands isKindOfClass:NSArray.class] || bands.count != 8 ||
      !isfinite(rms.doubleValue) || !isfinite(peak.doubleValue)) {
    return;
  }
  for (id band in bands) {
    if (![band isKindOfClass:NSNumber.class] || !isfinite([band doubleValue])) {
      return;
    }
  }
  self.level = @{
    @"rmsDb" : rms,
    @"peakDb" : peak,
    @"bands" : bands,
    @"at" : @((int64_t)(NSDate.date.timeIntervalSince1970 * 1000))
  };
  [self flush];
}
- (void)flush {
  NSMutableDictionary *state = [@{
    @"playing" : @(self.playing),
    @"changedAt" : @(self.changedAt)
  } mutableCopy];
  if (self.level != nil) {
    state[@"level"] = self.level;
  }
  // The process that plays this page's sound: WebKit renders audio in a GPU
  // process of the surface's own, which an agent may tap to hear media too.
  SEL gpu = NSSelectorFromString(@"_gpuProcessIdentifier");
  WKWebView *web = self.web;
  if (web != nil && [web respondsToSelector:gpu]) {
    pid_t gpuPid = ((pid_t(*)(id, SEL))objc_msgSend)(web, gpu);
    if (gpuPid > 0) {
      state[@"gpuPid"] = @(gpuPid);
    }
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:state
                                                 options:0
                                                   error:NULL];
  // The surface can start before its launcher creates the state directory.
  [NSFileManager.defaultManager
            createDirectoryAtPath:[self.path stringByDeletingLastPathComponent]
      withIntermediateDirectories:YES
                       attributes:@{NSFilePosixPermissions : @0700}
                            error:NULL];
  [data writeToFile:self.path atomically:YES];
}
- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
  id value = change[NSKeyValueChangeNewKey];
  [self write:[value isKindOfClass:NSNumber.class] && [value boolValue]];
}
@end

static AudioStateWriter *gAudioState = nil;

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
      return SelfTest();
    }
    BOOL multiPointer = NO;
    if (argc >= 5 && strcmp(argv[argc - 1], "--multi-pointer") == 0) {
      multiPointer = YES;
      argc -= 1;
    }
    if (argc < 4) {
      fprintf(stderr, "usage: opencua-surface <url> <title> <x,y,width,height> "
                      "[cursor-names.json]\n");
      return 2;
    }
    NSURL *url = [NSURL URLWithString:@(argv[1])];
    NSArray<NSString *> *frameParts =
        [@(argv[3]) componentsSeparatedByString:@","];
    if (url == nil || frameParts.count != 4) {
      fprintf(stderr, "opencua-surface: invalid url or frame\n");
      return 2;
    }
    if (argc > 4) {
      gNamesPath = @(argv[4]);
    }
    NSApplication *app = NSApplication.sharedApplication;
    app.activationPolicy = NSApplicationActivationPolicyAccessory;
    CGFloat screenTop = NSMaxY(NSScreen.screens.firstObject.frame);
    NSRect content = NSMakeRect(
        frameParts[0].doubleValue,
        screenTop - frameParts[1].doubleValue - frameParts[3].doubleValue,
        frameParts[2].doubleValue, frameParts[3].doubleValue);
    SurfaceWindow *window = [[SurfaceWindow alloc]
        initWithContentRect:content
                  styleMask:NSWindowStyleMaskTitled |
                            NSWindowStyleMaskMiniaturizable
                    backing:NSBackingStoreBuffered
                      defer:NO];
    window.title = @(argv[2]);
    window.releasedWhenClosed = NO;
    NSView *root =
        [[NSView alloc] initWithFrame:((NSView *)window.contentView).bounds];
    root.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    window.contentView = root;
    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    PageAck *ack = [PageAck new];
    [configuration.userContentController
        addUserScript:
            [[WKUserScript alloc]
                  initWithSource:kPageAckScript
                   injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                forMainFrameOnly:YES]];
    [configuration.userContentController
        addScriptMessageHandler:ack
                           name:@"opencuaInput"];
    if (multiPointer) {
      [configuration.userContentController
          addUserScript:
              [[WKUserScript alloc]
                    initWithSource:kMultiPointerScript
                     injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                  forMainFrameOnly:YES]];
    }
    SurfaceWebView *web = [[SurfaceWebView alloc] initWithFrame:root.bounds
                                                  configuration:configuration];
    ack.web = web;
    __weak SurfaceWindow *ackTarget = window;
    ack.handled = ^(BOOL down, NSPoint location) {
      [ackTarget pageHandled:down at:location];
    };
    window.paced = YES;
    window.multiPointer = multiPointer;
    window.web = web;
    web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    // WebKit stops painting a window it believes is covered; the surface sits
    // behind the person's windows on purpose, so keep it rendering or agents
    // would capture a blank page.
    SEL occlusion =
        NSSelectorFromString(@"_setWindowOcclusionDetectionEnabled:");
    if ([web respondsToSelector:occlusion]) {
      ((void (*)(id, SEL, BOOL))objc_msgSend)(web, occlusion, NO);
    }
    [root addSubview:web];
    CursorLayerView *layer =
        [[CursorLayerView alloc] initWithFrame:root.bounds];
    layer.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    layer.marks = [NSMutableDictionary dictionary];
    layer.names = @{};
    [root addSubview:layer];
    window.cursorLayer = layer;
    if (argc >= 5) {
      NSString *socketPath = [[@(argv[4]) stringByDeletingLastPathComponent]
          stringByAppendingPathComponent:
              [NSString stringWithFormat:@"surface-%d.sock", getpid()]];
      gAgentChannel = [AgentChannel new];
      __weak SurfaceWindow *target = window;
      if (![gAgentChannel
              listenAt:socketPath
               deliver:^(int64_t tag, BOOL context, MuxKind kind,
                         NSPoint topLeft) {
                 SurfaceWindow *surface = target;
                 if (surface == nil) {
                   return;
                 }
                 NSPoint location = NSMakePoint(
                     topLeft.x, surface.frame.size.height - topLeft.y);
                 [surface agent:tag kind:kind at:location context:context];
               }]) {
        gAgentChannel = nil;
      }
    }
    if (argc >= 5 &&
        [web respondsToSelector:NSSelectorFromString(@"_isPlayingAudio")]) {
      gAudioState = [AudioStateWriter new];
      gAudioState.web = web;
      gAudioState.path = [[@(argv[4]) stringByDeletingLastPathComponent]
          stringByAppendingPathComponent:
              [NSString stringWithFormat:@"surface-%d.audio.json", getpid()]];
      [gAudioState write:NO];
      [configuration.userContentController
          addUserScript:[[WKUserScript alloc]
                            initWithSource:kAudioTapScript
                             injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                          forMainFrameOnly:NO]];
      [configuration.userContentController addScriptMessageHandler:gAudioState
                                                              name:@"opencuaAudio"];
      [web addObserver:gAudioState
            forKeyPath:@"_isPlayingAudio"
               options:NSKeyValueObservingOptionNew
               context:NULL];
    }
    if (url.isFileURL) {
      [web loadFileURL:url
          allowingReadAccessToURL:url.URLByDeletingLastPathComponent];
    } else {
      [web loadRequest:[NSURLRequest requestWithURL:url]];
    }
    // Shown behind every other window and never activated, so it never covers
    // what the person is doing; they bring it forward themselves to watch.
    window.level = NSNormalWindowLevel - 1;
    // Follow the person across Spaces (including full-screen ones) without ever
    // switching Spaces for them; otherwise a Space change takes the surface off
    // screen and every agent working in it loses its window mid-task.
    window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                NSWindowCollectionBehaviorStationary |
                                NSWindowCollectionBehaviorIgnoresCycle |
                                NSWindowCollectionBehaviorFullScreenAuxiliary;
    [window orderBack:nil];
    __block NSData *lastNames = nil;
    [NSTimer
        scheduledTimerWithTimeInterval:1.0
                               repeats:YES
                                 block:^(NSTimer *timer) {
                                   if (gNamesPath == nil) {
                                     return;
                                   }
                                   NSData *data = [NSData
                                       dataWithContentsOfFile:gNamesPath];
                                   // Redraw only when a name changed.
                                   if (data == nil ||
                                       [data isEqualToData:lastNames]) {
                                     return;
                                   }
                                   lastNames = data;
                                   id parsed =
                                       data == nil
                                           ? nil
                                           : [NSJSONSerialization
                                                 JSONObjectWithData:data
                                                            options:0
                                                              error:NULL];
                                   if ([parsed
                                           isKindOfClass:NSDictionary.class]) {
                                     layer.names = parsed;
                                     layer.needsDisplay = YES;
                                   }
                                 }];
    [app run];
  }
  return 0;
}
