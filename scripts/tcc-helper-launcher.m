// Runs the bundled Node so that macOS attributes the server's Accessibility,
// Screen Recording and Automation asks to this bundle ("opencua-mcp",
// dev.opencua.mcp) instead of whatever launched it.
//
// macOS charges a permission to a process's responsible process. A process
// spawned with responsibility disclaimed is responsible for itself, and its
// children inherit that. So the launcher first re-spawns itself disclaimed,
// which makes this bundle's executable the responsible process, and that copy
// spawns Node normally. Disclaiming Node directly would make the bare `node`
// binary responsible: the dialogs and System Settings would then say "node".
// Each stage forwards termination signals and exits with its child's status.
//
// For the MCP server (server.js without --supervised-child, --doctor or
// --request-permissions, and OPENCUA_SUPERVISOR not "off") the responsible copy
// is also the stdio supervisor that packages/mcp/src/supervisor.ts implements
// for a plain `node server.js`: it owns the client's stdio and runs the server
// as a child, so a crash, a rebuilt server or a newly granted permission
// restarts the child behind the same connection. Doing that here instead of in
// a second Node process saves one Node runtime for every agent and subagent
// session. Behavior mirrors supervisor.ts; change both together.
#import <CoreServices/CoreServices.h>
#import <Foundation/Foundation.h>
#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

// Declared here because the private SDK header that carries it is not installed
// with the CLT.
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attributes,
                                                 int disclaim);

extern char **environ;

// Set in the re-spawned copy, which is the responsible process.
static const char *const kResponsibleStage = "OPENCUA_MCP_RESPONSIBLE";

static pid_t childPid = -1;

static void forwardSignal(int signalNumber) {
  if (childPid > 0) {
    kill(childPid, signalNumber);
  }
}

// Spawns argv[0] and waits for it, forwarding termination signals.
static int spawnAndWait(char **childArgv, posix_spawnattr_t *attributes) {
  if (posix_spawn(&childPid, childArgv[0], NULL, attributes, childArgv,
                  environ) != 0) {
    fprintf(stderr, "opencua-mcp: cannot spawn %s\n", childArgv[0]);
    return 1;
  }
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = forwardSignal;
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);

  int status = 0;
  pid_t waited;
  while ((waited = waitpid(childPid, &status, 0)) == -1 && errno == EINTR) {
  }
  if (waited == -1) {
    return 1;
  }
  if (WIFEXITED(status)) {
    return WEXITSTATUS(status);
  }
  if (WIFSIGNALED(status)) {
    return 128 + WTERMSIG(status);
  }
  return 1;
}

#pragma mark - Supervisor

static NSString *const kUnknownOutcome =
    @"opencua restarted while this call ran; its outcome is unknown. Observe "
    @"again before acting and never replay it.";
static NSString *const kSupervisedChildFlag = @"--supervised-child";
static NSString *const kSelfCheckFlag = @"--doctor";
static NSString *const kPermissionRequestFlag = @"--request-permissions";
static const NSUInteger kMaxLineBytes = 32 * 1024 * 1024;
static const int64_t kDefaultDrainMs = 15000;
static const int64_t kToolsProbeMs = 5000;
static const NSUInteger kMaxCrashes = 5;
static const NSTimeInterval kCrashWindow = 60;
static const NSTimeInterval kNotifyDedupe = 10;

static void Log(NSString *line) { fprintf(stderr, "%s\n", line.UTF8String); }

// Byte-bounded NDJSON framing. An oversized line is discarded through its next
// newline and reported once.
@interface LineFramer : NSObject
- (instancetype)initWithLine:(void (^)(NSData *line))line
                      reject:(void (^)(void))reject;
- (void)feed:(const char *)bytes length:(size_t)length;
- (void)finish;
@end

@implementation LineFramer {
  void (^_line)(NSData *);
  void (^_reject)(void);
  NSMutableData *_buffer;
  NSUInteger _bytes;
  BOOL _rejected;
}

- (instancetype)initWithLine:(void (^)(NSData *))line
                      reject:(void (^)(void))reject {
  self = [super init];
  if (self != nil) {
    _line = line;
    _reject = reject;
    _buffer = [NSMutableData data];
  }
  return self;
}

- (void)feed:(const char *)bytes length:(size_t)length {
  size_t offset = 0;
  while (offset < length) {
    const char *newline = memchr(bytes + offset, '\n', length - offset);
    size_t end = newline == NULL ? length : (size_t)(newline - bytes);
    size_t part = end - offset;
    _bytes += part;
    if (!_rejected && _bytes > kMaxLineBytes) {
      _rejected = YES;
      _buffer.length = 0;
      _reject();
    }
    if (!_rejected) {
      [_buffer appendBytes:bytes + offset length:part];
    }
    if (newline != NULL) {
      if (!_rejected) {
        _line([_buffer copy]);
      }
      _buffer.length = 0;
      _bytes = 0;
      _rejected = NO;
      offset = end + 1;
    } else {
      offset = end;
    }
  }
}

- (void)finish {
  if (_bytes > 0 && !_rejected) {
    _line([_buffer copy]);
  }
  _buffer.length = 0;
  _bytes = 0;
}
@end

// Buffered non-blocking writer, so the supervisor never blocks on a peer that
// is itself blocked writing to it.
@interface Writer : NSObject
- (instancetype)initWithFd:(int)fd;
- (void)write:(NSData *)data;
- (void)flushAndClose:(BOOL)shouldClose;
- (void)discardAndClose;
@end

@implementation Writer {
  int _fd;
  NSMutableData *_pending;
  // Exists only while output waits for the peer; created on demand so no
  // inactive or suspended source is ever released.
  dispatch_source_t _source;
  BOOL _broken;
  BOOL _closed;
}

- (instancetype)initWithFd:(int)fd {
  self = [super init];
  if (self != nil) {
    _fd = fd;
    _pending = [NSMutableData data];
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  }
  return self;
}

- (void)drainOnce {
  while (_pending.length > 0 && !_broken) {
    ssize_t written = write(_fd, _pending.bytes, _pending.length);
    if (written > 0) {
      [_pending replaceBytesInRange:NSMakeRange(0, (NSUInteger)written)
                          withBytes:NULL
                             length:0];
      continue;
    }
    if (written < 0 && (errno == EAGAIN || errno == EINTR)) {
      return;
    }
    _broken = YES;
    _pending.length = 0;
  }
}

- (void)writable {
  [self drainOnce];
  if ((_pending.length == 0 || _broken) && _source != nil) {
    dispatch_source_cancel(_source);
    _source = nil;
  }
}

- (void)write:(NSData *)data {
  if (_broken || _closed) {
    return;
  }
  [_pending appendData:data];
  if (_source != nil) {
    return;
  }
  [self drainOnce];
  if (_pending.length > 0 && !_broken) {
    _source = dispatch_source_create(DISPATCH_SOURCE_TYPE_WRITE, (uintptr_t)_fd,
                                     0, dispatch_get_main_queue());
    __weak Writer *weakSelf = self;
    dispatch_source_set_event_handler(_source, ^{
      [weakSelf writable];
    });
    dispatch_resume(_source);
  }
}

- (void)flushAndClose:(BOOL)shouldClose {
  dispatch_source_t source = _source;
  _source = nil;
  fcntl(_fd, F_SETFL, fcntl(_fd, F_GETFL) & ~O_NONBLOCK);
  while (_pending.length > 0 && !_broken) {
    ssize_t written = write(_fd, _pending.bytes, _pending.length);
    if (written > 0) {
      [_pending replaceBytesInRange:NSMakeRange(0, (NSUInteger)written)
                          withBytes:NULL
                             length:0];
    } else if (!(written < 0 && errno == EINTR)) {
      _broken = YES;
    }
  }
  if (!shouldClose || _closed) {
    if (source != nil) {
      dispatch_source_cancel(source);
    }
    return;
  }
  _closed = YES;
  int fd = _fd;
  if (source == nil) {
    close(fd);
    return;
  }
  // Closed after the source is gone so the descriptor is not reused under it.
  dispatch_source_set_cancel_handler(source, ^{
    close(fd);
  });
  dispatch_source_cancel(source);
}

// Closes without writing what is still pending: a stuck reader must not hold
// up a shutdown that is about to terminate it anyway.
- (void)discardAndClose {
  _pending.length = 0;
  _broken = YES;
  [self flushAndClose:YES];
}
@end

// JSON-RPC ids are strings, numbers or null; booleans are not ids.
static BOOL HasId(NSDictionary *message) {
  id value = message[@"id"];
  if (value == nil) {
    return NO;
  }
  if ([value isKindOfClass:NSString.class] || value == NSNull.null) {
    return YES;
  }
  return [value isKindOfClass:NSNumber.class] &&
         CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID();
}

static NSString *IdKey(id value) {
  if ([value isKindOfClass:NSString.class]) {
    return [@"s:" stringByAppendingString:value];
  }
  if ([value isKindOfClass:NSNumber.class]) {
    return [@"n:" stringByAppendingString:[value stringValue]];
  }
  return @"null";
}

static BOOL IsMethod(NSDictionary *message) {
  return [message[@"method"] isKindOfClass:NSString.class];
}

static NSData *Line(id object) {
  NSMutableData *data = [[NSJSONSerialization
      dataWithJSONObject:object
                 options:NSJSONWritingWithoutEscapingSlashes
                   error:NULL] mutableCopy];
  [data appendBytes:"\n" length:1];
  return data;
}

static NSData *RawLine(NSData *line) {
  NSMutableData *data = [line mutableCopy];
  [data appendBytes:"\n" length:1];
  return data;
}

static NSString *ToolsFingerprint(NSDictionary *message) {
  NSDictionary *result = message[@"result"];
  if (message[@"error"] != nil || ![result isKindOfClass:NSDictionary.class] ||
      ![result[@"tools"] isKindOfClass:NSArray.class]) {
    return nil;
  }
  NSData *data = [NSJSONSerialization
      dataWithJSONObject:result[@"tools"]
                 options:NSJSONWritingSortedKeys |
                         NSJSONWritingWithoutEscapingSlashes
                   error:NULL];
  return data == nil ? nil
                     : [[NSString alloc] initWithData:data
                                             encoding:NSUTF8StringEncoding];
}

static int64_t DrainMilliseconds(void) {
  const char *raw = getenv("OPENCUA_SUPERVISOR_DRAIN_MS");
  if (raw == NULL) {
    return kDefaultDrainMs;
  }
  NSString *value = [@(raw)
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  if (value.length == 0 ||
      [value rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet
                                         .invertedSet]
              .location != NSNotFound) {
    return kDefaultDrainMs;
  }
  return value.longLongValue;
}

static dispatch_source_t After(int64_t milliseconds, dispatch_block_t block) {
  dispatch_source_t timer = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(
      timer, dispatch_time(DISPATCH_TIME_NOW, milliseconds * NSEC_PER_MSEC),
      DISPATCH_TIME_FOREVER, 10 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(timer, ^{
    dispatch_source_cancel(timer);
    block();
  });
  dispatch_resume(timer);
  return timer;
}

static void Cancel(dispatch_source_t __strong *timer) {
  if (*timer != nil) {
    dispatch_source_cancel(*timer);
    *timer = nil;
  }
}

static NSMutableDictionary<NSString *, NSDate *> *gNotified;

// Best-effort macOS notification, deduplicated like notify.ts.
static void Notify(NSString *title, NSString *body) {
  const char *setting = getenv("OPENCUA_NOTIFICATIONS");
  if (setting != NULL &&
      [[@(setting) stringByTrimmingCharactersInSet:NSCharacterSet
                                                       .whitespaceCharacterSet]
              .lowercaseString isEqualToString:@"off"]) {
    return;
  }
  if (gNotified == nil) {
    gNotified = [NSMutableDictionary dictionary];
  }
  NSDate *now = NSDate.date;
  for (NSString *key in gNotified.allKeys) {
    if ([now timeIntervalSinceDate:gNotified[key]] >= kNotifyDedupe) {
      [gNotified removeObjectForKey:key];
    }
  }
  NSString *key = [NSString stringWithFormat:@"%@\n%@", title, body];
  if (gNotified[key] != nil) {
    return;
  }
  gNotified[key] = now;
  NSString * (^escape)(NSString *) = ^NSString *(NSString *value) {
    return [[value stringByReplacingOccurrencesOfString:@"\\"
                                             withString:@"\\\\"]
        stringByReplacingOccurrencesOfString:@"\""
                                  withString:@"\\\""];
  };
  NSString *script = [NSString
      stringWithFormat:@"on run argv\ndisplay notification \"%@\" with title "
                       @"\"%@\"\nend run",
                       escape(body), escape(title)];
  NSTask *task = [NSTask new];
  task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/osascript"];
  task.arguments = @[ @"-e", script ];
  task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
  task.standardError = NSFileHandle.fileHandleWithNullDevice;
  if (![task launchAndReturnError:NULL]) {
    return;
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC),
                 dispatch_get_main_queue(), ^{
                   if (task.running) {
                     [task terminate];
                   }
                 });
}

@interface Supervisor : NSObject
- (instancetype)initWithNode:(NSString *)node
                      script:(NSString *)script
                   arguments:(NSArray<NSString *> *)arguments;
- (void)start;
@end

@implementation Supervisor {
  NSString *_node;
  NSString *_script;
  NSArray<NSString *> *_arguments;
  Writer *_client;
  LineFramer *_input;
  dispatch_source_t _inputSource;

  pid_t _child;
  Writer *_childIn;
  dispatch_source_t _childOut;
  dispatch_source_t _childExit;
  LineFramer *_childFramer;

  BOOL _stopped;
  BOOL _restarting;
  BOOL _initialized;
  BOOL _rewritten;
  BOOL _probingTools;
  NSString *_pendingRestart;
  NSString *_restartReason;
  NSString *_internalId;
  NSString *_previousTools;
  NSDictionary *_initialization;
  NSUInteger _generation;
  NSMutableDictionary<NSString *, NSDictionary *> *_inFlight;
  NSMutableArray<NSString *> *_inFlightOrder;
  NSMutableArray<NSArray *> *_queued;
  NSMutableArray<NSDate *> *_crashes;
  dispatch_source_t _drainTimer;
  dispatch_source_t _toolsProbeTimer;

  FSEventStreamRef _watch;
  dispatch_source_t _debounce;
  BOOL _permissionProbing;
  dispatch_source_t _permissionInterval;
  NSDictionary *_permissions;
  NSMutableArray<dispatch_source_t> *_signals;
}

- (instancetype)initWithNode:(NSString *)node
                      script:(NSString *)script
                   arguments:(NSArray<NSString *> *)arguments {
  self = [super init];
  if (self != nil) {
    _node = node;
    _script = script;
    _arguments = arguments;
    _child = -1;
    _inFlight = [NSMutableDictionary dictionary];
    _inFlightOrder = [NSMutableArray array];
    _queued = [NSMutableArray array];
    _crashes = [NSMutableArray array];
    _signals = [NSMutableArray array];
  }
  return self;
}

#pragma mark Client side

- (void)send:(id)message {
  [_client write:Line(message)];
}

- (void)error:(id)identifier message:(NSString *)message code:(NSInteger)code {
  [self send:@{
    @"jsonrpc" : @"2.0",
    @"id" : identifier ?: NSNull.null,
    @"error" : @{@"code" : @(code), @"message" : message}
  }];
}

- (void)failRequests:(NSString *)reason includeQueued:(BOOL)includeQueued {
  for (NSString *key in _inFlightOrder) {
    [self error:_inFlight[key][@"id"] message:reason code:-32000];
  }
  [_inFlight removeAllObjects];
  [_inFlightOrder removeAllObjects];
  if (!includeQueued) {
    return;
  }
  for (NSArray *entry in _queued) {
    NSDictionary *message = entry[1];
    if (HasId(message) && IsMethod(message)) {
      [self error:message[@"id"] message:reason code:-32000];
    }
  }
  [_queued removeAllObjects];
}

- (void)stop:(int)code {
  if (_stopped) {
    return;
  }
  _stopped = YES;
  Cancel(&_toolsProbeTimer);
  Cancel(&_drainTimer);
  [self unsubscribe];
  [self detach];
  if (_inputSource != nil) {
    dispatch_source_cancel(_inputSource);
  }
  [_childIn discardAndClose];
  if (_child > 0) {
    // The session ends with its server: wait for it so no server outlives the
    // connection, and force it after two seconds.
    kill(_child, SIGTERM);
    int status = 0;
    BOOL reaped = NO;
    for (int tick = 0; tick < 200 && !reaped; tick += 1) {
      pid_t waited = waitpid(_child, &status, WNOHANG);
      reaped = waited == _child || (waited == -1 && errno == ECHILD);
      if (!reaped) {
        usleep(10000);
      }
    }
    if (!reaped) {
      kill(_child, SIGKILL);
      while (waitpid(_child, &status, 0) == -1 && errno == EINTR) {
      }
    }
  }
  [_client flushAndClose:NO];
  exit(code);
}

- (void)forward:(NSData *)raw message:(NSDictionary *)message {
  if (HasId(message) && IsMethod(message)) {
    NSString *key = IdKey(message[@"id"]);
    if (_inFlight[key] == nil) {
      [_inFlightOrder addObject:key];
    }
    _inFlight[key] = message;
  }
  [_childIn write:RawLine(raw)];
}

- (void)removeInFlight:(NSString *)key {
  [_inFlight removeObjectForKey:key];
  [_inFlightOrder removeObject:key];
}

- (void)restartIfIdle {
  if (_stopped || _restarting || _pendingRestart == nil) {
    return;
  }
  if (_inFlight.count > 0) {
    if (_drainTimer == nil) {
      __weak Supervisor *weakSelf = self;
      _drainTimer = After(DrainMilliseconds(), ^{
        [weakSelf drainExpired];
      });
    }
    return;
  }
  Cancel(&_drainTimer);
  Log([NSString stringWithFormat:@"opencua restarting: %@", _pendingRestart]);
  _pendingRestart = nil;
  _restarting = YES;
  if (_child > 0) {
    kill(_child, SIGTERM);
  }
}

- (void)drainExpired {
  _drainTimer = nil;
  if (_stopped || _restarting || _pendingRestart == nil ||
      _inFlight.count == 0) {
    return;
  }
  [self failRequests:kUnknownOutcome includeQueued:NO];
  [self restartIfIdle];
}

- (void)clientLine:(NSData *)line {
  id parsed =
      [NSJSONSerialization JSONObjectWithData:line
                                      options:NSJSONReadingFragmentsAllowed
                                        error:NULL];
  if (parsed == nil) {
    [self error:NSNull.null message:@"Parse error" code:-32700];
    return;
  }
  if (![parsed isKindOfClass:NSDictionary.class]) {
    [self error:NSNull.null message:@"Invalid Request" code:-32600];
    return;
  }
  NSDictionary *message = parsed;
  NSString *method = IsMethod(message) ? message[@"method"] : nil;
  if ([method isEqualToString:@"initialize"]) {
    _initialization = message;
  }
  if ([method isEqualToString:@"notifications/initialized"]) {
    _initialized = YES;
  }
  // Heartbeats measure this connection, not a native call or a child reload.
  if ([method isEqualToString:@"ping"] && HasId(message)) {
    [self send:@{@"jsonrpc" : @"2.0", @"id" : message[@"id"], @"result" : @{}}];
    return;
  }
  if (_restarting) {
    [_queued addObject:@[ line, message ]];
  } else {
    [self forward:line message:message];
  }
}

#pragma mark Child side

- (void)childLine:(NSData *)line {
  id parsed =
      [NSJSONSerialization JSONObjectWithData:line
                                      options:NSJSONReadingFragmentsAllowed
                                        error:NULL];
  if (parsed == nil) {
    Log(@"opencua child emitted malformed JSON");
    return;
  }
  if (![parsed isKindOfClass:NSDictionary.class]) {
    return;
  }
  NSDictionary *message = parsed;
  if (!(HasId(message) && !IsMethod(message))) {
    [_client write:RawLine(line)];
    return;
  }
  id identifier = message[@"id"];
  if (_internalId != nil && [identifier isEqual:_internalId]) {
    [self internalResponse:message];
    return;
  }
  NSString *key = IdKey(identifier);
  NSDictionary *request = _inFlight[key];
  if ([request[@"method"] isEqual:@"tools/list"]) {
    NSString *fingerprint = ToolsFingerprint(message);
    if (fingerprint != nil) {
      _previousTools = fingerprint;
    }
  }
  NSDictionary *result = message[@"result"];
  if (!_rewritten && [request[@"method"] isEqual:@"initialize"] &&
      [result isKindOfClass:NSDictionary.class]) {
    NSMutableDictionary *capabilities =
        [result[@"capabilities"] isKindOfClass:NSDictionary.class]
            ? [result[@"capabilities"] mutableCopy]
            : [NSMutableDictionary dictionary];
    NSMutableDictionary *tools =
        [capabilities[@"tools"] isKindOfClass:NSDictionary.class]
            ? [capabilities[@"tools"] mutableCopy]
            : [NSMutableDictionary dictionary];
    tools[@"listChanged"] = @YES;
    capabilities[@"tools"] = tools;
    NSMutableDictionary *rewrittenResult = [result mutableCopy];
    rewrittenResult[@"capabilities"] = capabilities;
    NSMutableDictionary *rewritten = [message mutableCopy];
    rewritten[@"result"] = rewrittenResult;
    _rewritten = YES;
    [self send:rewritten];
  } else {
    // Preserve response-before-restart ordering on the client stream.
    [_client write:RawLine(line)];
  }
  [self removeInFlight:key];
  if (_inFlight.count == 0) {
    Cancel(&_drainTimer);
  }
  [self restartIfIdle];
}

- (void)internalResponse:(NSDictionary *)message {
  Cancel(&_drainTimer);
  Cancel(&_toolsProbeTimer);
  _internalId = nil;
  if (!_probingTools) {
    if (message[@"error"] != nil) {
      Log(@"opencua child re-initialization failed");
      [self failRequests:@"opencua re-initialization failed" includeQueued:YES];
      [self stop:1];
      return;
    }
    if (_initialized) {
      [_childIn write:Line(@{
                  @"jsonrpc" : @"2.0",
                  @"method" : @"notifications/initialized"
                })];
    }
    _probingTools = YES;
    _internalId = [NSString stringWithFormat:@"opencua-supervisor-tools-%lu",
                                             (unsigned long)_generation];
    [_childIn write:Line(@{
                @"jsonrpc" : @"2.0",
                @"id" : _internalId,
                @"method" : @"tools/list"
              })];
    __weak Supervisor *weakSelf = self;
    _toolsProbeTimer = After(kToolsProbeMs, ^{
      [weakSelf toolsProbeExpired];
    });
    return;
  }
  _probingTools = NO;
  NSString *fingerprint = ToolsFingerprint(message);
  if (fingerprint == nil || _previousTools == nil ||
      ![fingerprint isEqualToString:_previousTools]) {
    [self send:@{
      @"jsonrpc" : @"2.0",
      @"method" : @"notifications/tools/list_changed"
    }];
  }
  _previousTools = fingerprint;
  _restarting = NO;
  _restartReason = nil;
  NSArray<NSArray *> *waiting = [_queued copy];
  [_queued removeAllObjects];
  for (NSArray *entry in waiting) {
    [self forward:entry[0] message:entry[1]];
  }
  [self restartIfIdle];
}

- (void)toolsProbeExpired {
  _toolsProbeTimer = nil;
  if (!_probingTools) {
    return;
  }
  Log(@"opencua tools/list probe timed out");
  _probingTools = NO;
  _internalId = nil;
  [self failRequests:
            @"opencua re-initialization timed out; observe again before acting"
       includeQueued:YES];
  _restarting = YES;
  if (_child > 0) {
    kill(_child, SIGTERM);
  }
}

- (void)detach {
  if (_childOut != nil) {
    dispatch_source_cancel(_childOut);
    _childOut = nil;
  }
  if (_childExit != nil) {
    dispatch_source_cancel(_childExit);
    _childExit = nil;
  }
}

- (void)childExited {
  [self detach];
  [_childIn flushAndClose:YES];
  _childIn = nil;
  _child = -1;
  Cancel(&_drainTimer);
  Cancel(&_toolsProbeTimer);
  if (_stopped) {
    return;
  }
  if (!_restarting || _internalId != nil) {
    [self failRequests:kUnknownOutcome includeQueued:NO];
    NSDate *now = NSDate.date;
    NSIndexSet *old = [_crashes
        indexesOfObjectsPassingTest:^BOOL(NSDate *time, NSUInteger index,
                                          BOOL *stop) {
          return [now timeIntervalSinceDate:time] > kCrashWindow;
        }];
    [_crashes removeObjectsAtIndexes:old];
    [_crashes addObject:now];
    if (_crashes.count > kMaxCrashes) {
      Log(@"opencua crash loop: restart limit exceeded");
      [self failRequests:@"opencua crash loop: restart limit exceeded"
           includeQueued:YES];
      [self stop:1];
      return;
    }
    NSString *reason =
        _restartReason ?: _pendingRestart ?: @"unexpected child exit";
    Notify(@"opencua",
           [NSString stringWithFormat:@"Server restarted after a child crash "
                                      @"(%@); observe again before acting.",
                                      reason]);
  }
  _restarting = YES;
  _internalId = nil;
  _pendingRestart = nil;
  [self launch];
}

- (BOOL)spawnChild {
  int toChild[2];
  int fromChild[2];
  if (pipe(toChild) != 0) {
    return NO;
  }
  if (pipe(fromChild) != 0) {
    close(toChild[0]);
    close(toChild[1]);
    return NO;
  }
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, toChild[0], STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&actions, fromChild[1], STDOUT_FILENO);
  posix_spawn_file_actions_addinherit_np(&actions, STDERR_FILENO);
  posix_spawnattr_t attributes;
  posix_spawnattr_init(&attributes);
  posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT);
  NSMutableArray<NSString *> *arguments = [NSMutableArray
      arrayWithObjects:_node, _script, kSupervisedChildFlag, nil];
  [arguments addObjectsFromArray:_arguments];
  char **argv = calloc(arguments.count + 1, sizeof(char *));
  for (NSUInteger index = 0; index < arguments.count; index += 1) {
    argv[index] = (char *)arguments[index].fileSystemRepresentation;
  }
  pid_t pid = -1;
  int spawned =
      posix_spawn(&pid, argv[0], &actions, &attributes, argv, environ);
  free(argv);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  close(toChild[0]);
  close(fromChild[1]);
  if (spawned != 0) {
    close(toChild[1]);
    close(fromChild[0]);
    return NO;
  }
  _child = pid;
  childPid = pid;
  _childIn = [[Writer alloc] initWithFd:toChild[1]];
  __weak Supervisor *weakSelf = self;
  _childFramer = [[LineFramer alloc]
      initWithLine:^(NSData *line) {
        [weakSelf childLine:line];
      }
      reject:^{
        Log(@"opencua child line exceeded 32 MiB");
      }];
  LineFramer *framer = _childFramer;
  int outFd = fromChild[0];
  fcntl(outFd, F_SETFL, fcntl(outFd, F_GETFL) | O_NONBLOCK);
  dispatch_source_t out =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)outFd, 0,
                             dispatch_get_main_queue());
  dispatch_source_set_event_handler(out, ^{
    char buffer[65536];
    for (;;) {
      ssize_t count = read(outFd, buffer, sizeof(buffer));
      if (count > 0) {
        [framer feed:buffer length:(size_t)count];
        continue;
      }
      if (count < 0 && (errno == EAGAIN || errno == EINTR)) {
        return;
      }
      dispatch_source_cancel(out);
      return;
    }
  });
  dispatch_source_set_cancel_handler(out, ^{
    close(outFd);
  });
  dispatch_resume(out);
  _childOut = out;
  dispatch_source_t exitSource =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)pid,
                             DISPATCH_PROC_EXIT, dispatch_get_main_queue());
  dispatch_source_set_event_handler(exitSource, ^{
    int status = 0;
    while (waitpid(pid, &status, 0) == -1 && errno == EINTR) {
    }
    Supervisor *strongSelf = weakSelf;
    if (strongSelf != nil && strongSelf->_child == pid) {
      [strongSelf childExited];
    }
  });
  dispatch_resume(exitSource);
  _childExit = exitSource;
  return YES;
}

- (void)launch {
  if (_stopped) {
    return;
  }
  if (![self spawnChild]) {
    Log([NSString
        stringWithFormat:@"opencua spawn failed: %s", strerror(errno)]);
    [self failRequests:@"opencua could not start" includeQueued:YES];
    [self stop:1];
    return;
  }
  if (_restarting) {
    if (_initialization != nil) {
      _probingTools = NO;
      _generation += 1;
      _internalId = [NSString stringWithFormat:@"opencua-supervisor-init-%lu",
                                               (unsigned long)_generation];
      NSMutableDictionary *replay = [_initialization mutableCopy];
      replay[@"id"] = _internalId;
      [_childIn write:Line(replay)];
    } else {
      _restarting = NO;
      [self send:@{
        @"jsonrpc" : @"2.0",
        @"method" : @"notifications/tools/list_changed"
      }];
    }
  }
  [self probePermissions];
}

#pragma mark Restart sources

- (void)requestRestart:(NSString *)reason {
  if (_stopped) {
    return;
  }
  if ([reason isEqualToString:@"permission-granted"]) {
    Notify(@"opencua", @"Permissions granted; server reloading.");
  }
  if (_restarting) {
    return;
  }
  if (_pendingRestart == nil) {
    _pendingRestart = reason;
  }
  if (_restartReason == nil) {
    _restartReason = reason;
  }
  [self restartIfIdle];
}

static void WatchCallback(ConstFSEventStreamRef stream, void *info,
                          size_t count, void *paths,
                          const FSEventStreamEventFlags flags[],
                          const FSEventStreamEventId ids[]) {
  Supervisor *supervisor = (__bridge Supervisor *)info;
  NSArray<NSString *> *changed = (__bridge NSArray<NSString *> *)paths;
  for (NSString *path in changed) {
    if (![path hasSuffix:@".map"]) {
      [supervisor buildChanged];
      return;
    }
  }
}

- (void)buildChanged {
  Cancel(&_debounce);
  __weak Supervisor *weakSelf = self;
  _debounce = After(1000, ^{
    Supervisor *strongSelf = weakSelf;
    if (strongSelf != nil) {
      strongSelf->_debounce = nil;
      [strongSelf requestRestart:@"build-changed"];
    }
  });
}

- (void)subscribe {
  NSString *directory = _script.stringByDeletingLastPathComponent;
  NSString *core =
      [[directory stringByAppendingPathComponent:@"../../core/dist"]
          stringByStandardizingPath];
  NSMutableArray<NSString *> *watched = [NSMutableArray array];
  for (NSString *path in @[ directory, core ]) {
    if ([NSFileManager.defaultManager fileExistsAtPath:path]) {
      [watched addObject:path];
    }
  }
  if (watched.count > 0) {
    FSEventStreamContext context = {0, (__bridge void *)self, NULL, NULL, NULL};
    _watch = FSEventStreamCreate(NULL, WatchCallback, &context,
                                 (__bridge CFArrayRef)watched,
                                 kFSEventStreamEventIdSinceNow, 0.1,
                                 kFSEventStreamCreateFlagFileEvents |
                                     kFSEventStreamCreateFlagUseCFTypes);
    if (_watch != NULL) {
      FSEventStreamSetDispatchQueue(_watch, dispatch_get_main_queue());
      FSEventStreamStart(_watch);
    }
  }
}

- (void)unsubscribe {
  if (_watch != NULL) {
    FSEventStreamStop(_watch);
    FSEventStreamInvalidate(_watch);
    FSEventStreamRelease(_watch);
    _watch = NULL;
  }
  Cancel(&_debounce);
  Cancel(&_permissionInterval);
}

// Runs `server.js --doctor` and restarts the child when a permission that was
// missing is now granted; while one is missing, checks again every 15 s.
- (void)probePermissions {
  if (_stopped || _permissionProbing) {
    return;
  }
  Cancel(&_permissionInterval);
  NSTask *task = [NSTask new];
  task.executableURL = [NSURL fileURLWithPath:_node];
  task.arguments = @[ _script, kSelfCheckFlag ];
  NSPipe *output = [NSPipe pipe];
  task.standardOutput = output;
  task.standardInput = NSFileHandle.fileHandleWithNullDevice;
  task.standardError = NSFileHandle.fileHandleWithNullDevice;
  _permissionProbing = YES;
  __weak Supervisor *weakSelf = self;
  task.terminationHandler = ^(NSTask *finished) {
    NSData *data = [output.fileHandleForReading readDataToEndOfFile];
    int code = finished.terminationStatus;
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf permissionReport:data code:code];
    });
  };
  if (![task launchAndReturnError:NULL]) {
    _permissionProbing = NO;
  }
}

- (void)permissionReport:(NSData *)data code:(int)code {
  _permissionProbing = NO;
  if (_stopped) {
    return;
  }
  if (code == 0) {
    id report = [NSJSONSerialization JSONObjectWithData:data
                                                options:0
                                                  error:NULL];
    NSDictionary *permissions = [report isKindOfClass:NSDictionary.class]
                                    ? report[@"permissions"]
                                    : nil;
    if ([permissions isKindOfClass:NSDictionary.class]) {
      BOOL granted = NO;
      for (NSString *key in permissions) {
        if ([_permissions[key] isEqual:@NO] &&
            [permissions[key] isEqual:@YES]) {
          granted = YES;
        }
      }
      _permissions = permissions;
      if (granted) {
        [self requestRestart:@"permission-granted"];
      }
    }
  }
  if ([_permissions.allValues containsObject:@NO]) {
    __weak Supervisor *weakSelf = self;
    _permissionInterval = After(15000, ^{
      Supervisor *strongSelf = weakSelf;
      if (strongSelf != nil) {
        strongSelf->_permissionInterval = nil;
        [strongSelf probePermissions];
      }
    });
  }
}

#pragma mark Start

- (void)start {
  signal(SIGPIPE, SIG_IGN);
  setenv("OPENCUA_SUPERVISED", "1", 1);
  // A 1 MB young generation keeps an idle server about 20 MB smaller with no
  // measured latency cost (tools/list and screenshot observe p50 unchanged);
  // every agent and subagent session runs one such server.
  const char *options = getenv("NODE_OPTIONS");
  if (options == NULL || strstr(options, "--max-semi-space-size") == NULL) {
    NSString *combined =
        options == NULL || options[0] == '\0'
            ? @"--max-semi-space-size=1"
            : [NSString
                  stringWithFormat:@"%s --max-semi-space-size=1", options];
    setenv("NODE_OPTIONS", combined.UTF8String, 1);
  }
  _client = [[Writer alloc] initWithFd:STDOUT_FILENO];
  __weak Supervisor *weakSelf = self;
  _input = [[LineFramer alloc]
      initWithLine:^(NSData *line) {
        [weakSelf clientLine:line];
      }
      reject:^{
        [weakSelf error:NSNull.null message:@"Parse error" code:-32700];
      }];
  LineFramer *input = _input;
  fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
  _inputSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO,
                                        0, dispatch_get_main_queue());
  dispatch_source_t source = _inputSource;
  dispatch_source_set_event_handler(source, ^{
    char buffer[65536];
    for (;;) {
      ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
      if (count > 0) {
        [input feed:buffer length:(size_t)count];
        continue;
      }
      if (count < 0 && (errno == EAGAIN || errno == EINTR)) {
        return;
      }
      Supervisor *strongSelf = weakSelf;
      if (count < 0 && strongSelf != nil) {
        Log([NSString
            stringWithFormat:@"opencua input failed: %s", strerror(errno)]);
        [strongSelf failRequests:@"opencua input failed" includeQueued:YES];
        [strongSelf stop:1];
        return;
      }
      [input finish];
      [strongSelf stop:0];
      return;
    }
  });
  dispatch_resume(source);
  for (NSNumber *number in @[ @(SIGHUP), @(SIGINT), @(SIGTERM) ]) {
    int signalNumber = number.intValue;
    signal(signalNumber, SIG_IGN);
    dispatch_source_t handler = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)signalNumber, 0,
        dispatch_get_main_queue());
    dispatch_source_set_event_handler(handler, ^{
      [weakSelf stop:128 + signalNumber];
    });
    dispatch_resume(handler);
    [_signals addObject:handler];
  }
  [self launch];
  if (!_stopped) {
    [self subscribe];
  }
}
@end

// The supervisor lives for the whole process; its sources hold it only weakly.
static Supervisor *gSupervisor;

// Whether the responsible stage should supervise this command line: the MCP
// server entry, run the way server.ts would otherwise supervise itself.
static BOOL ShouldSupervise(int argc, char **argv) {
  const char *setting = getenv("OPENCUA_SUPERVISOR");
  if (setting != NULL && strcmp(setting, "off") == 0) {
    return NO;
  }
  if (argc < 2 || ![@(argv[1]).lastPathComponent
                      isEqualToString:@"server.js"]) {
    return NO;
  }
  for (int index = 2; index < argc; index += 1) {
    NSString *argument = @(argv[index]);
    if ([argument isEqualToString:kSupervisedChildFlag] ||
        [argument isEqualToString:kSelfCheckFlag] ||
        [argument isEqualToString:kPermissionRequestFlag]) {
      return NO;
    }
  }
  return YES;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: opencua-mcp <server.js> [server args...]\n");
    return 2;
  }

  char executablePath[PATH_MAX];
  char resolvedPath[PATH_MAX];
  char nodePath[PATH_MAX];
  uint32_t executablePathSize = sizeof(executablePath);
  if (_NSGetExecutablePath(executablePath, &executablePathSize) != 0) {
    fprintf(stderr, "opencua-mcp: cannot resolve its own path\n");
    return 1;
  }
  if (realpath(executablePath, resolvedPath) == NULL) {
    snprintf(resolvedPath, sizeof(resolvedPath), "%s", executablePath);
  }
  char directory[PATH_MAX];
  snprintf(directory, sizeof(directory), "%s", resolvedPath);
  snprintf(nodePath, sizeof(nodePath), "%s/../Resources/node",
           dirname(directory));
  if (access(nodePath, X_OK) != 0) {
    fprintf(stderr, "opencua-mcp: bundled node missing at %s\n", nodePath);
    return 1;
  }

  const int responsible = getenv(kResponsibleStage) != NULL;
  if (responsible) {
    unsetenv(kResponsibleStage);
    if (ShouldSupervise(argc, argv)) {
      @autoreleasepool {
        NSMutableArray<NSString *> *arguments = [NSMutableArray array];
        for (int index = 2; index < argc; index += 1) {
          [arguments addObject:@(argv[index])];
        }
        gSupervisor = [[Supervisor alloc] initWithNode:@(nodePath)
                                                script:@(argv[1])
                                             arguments:arguments];
        [gSupervisor start];
      }
      dispatch_main();
    }
  }

  char **childArgv = calloc((size_t)argc + 1, sizeof(char *));
  if (childArgv == NULL) {
    return 1;
  }
  childArgv[0] = responsible ? nodePath : resolvedPath;
  for (int i = 1; i < argc; i++) {
    childArgv[i] = argv[i];
  }

  posix_spawnattr_t attributes;
  posix_spawnattr_init(&attributes);
  if (!responsible) {
    setenv(kResponsibleStage, "1", 1);
    if (responsibility_spawnattrs_setdisclaim(&attributes, 1) != 0) {
      fprintf(stderr, "opencua-mcp: responsibility disclaim unavailable; "
                      "permissions are charged to whatever launched it\n");
    }
  }
  int status = spawnAndWait(childArgv, &attributes);
  posix_spawnattr_destroy(&attributes);
  free(childArgv);
  return status;
}
