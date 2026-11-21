// voice-input: speech to text for the opencua buddy (push-to-talk questions and
// agent requests).
//
//   voice-input --file <audio> [--locale ko-KR,en-US]   transcribe an audio
//   file voice-input --mic [--max-seconds 60] [--locale ...]
//       listen to the microphone until stdin closes (the push-to-talk key was
//       released), SIGTERM/SIGINT, or the time limit; partial transcripts
//       stream as they arrive
//   voice-input --serve [--max-seconds 60] [--locale ...]
//       stay ready between questions: permissions, recognizers and the audio
//       engine are set up once, then each "start" line on stdin listens until
//       a "stop" line; stdin closing ends the process
//
// --locale takes one or more comma-separated locales, or "auto" (the default):
// the Mac's preferred languages that have a recognizer, at most three. With
// several, every recognizer hears the same audio and the transcript with the
// best mean confidence wins.
//
// Output is JSON lines on stdout: {"ready":true,"locales":[...]} once set up,
// {"listening":true} when the microphone is on, {"partial":"..."} while
// listening, then one {"text":"...","locale":"..."} line per question, or
// {"error":"<code>","message":"..."} with exit status 2 when permission is
// missing and 1 on other failures.
//
// macOS charges the microphone and speech-recognition permissions to the
// responsible process. Like the opencua-mcp launcher, this binary first
// re-spawns itself with responsibility disclaimed, so the permission dialogs
// name voice-input (its Info.plist is embedded in __TEXT,__info_plist) instead
// of the terminal or agent that started it, and one grant covers every caller.
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attributes,
                                                 int disclaim);
extern char **environ;

static const char *const kResponsibleStage = "OPENCUA_VOICE_RESPONSIBLE";
static pid_t gChild = -1;

static void forward_signal(int signal_number) {
  if (gChild > 0)
    kill(gChild, signal_number);
}

static int respawn_disclaimed(int argc, char **argv) {
  setenv(kResponsibleStage, "1", 1);
  posix_spawnattr_t attributes;
  posix_spawnattr_init(&attributes);
  responsibility_spawnattrs_setdisclaim(&attributes, 1);
  char **child_argv = calloc((size_t)argc + 1, sizeof(char *));
  for (int index = 0; index < argc; index++)
    child_argv[index] = argv[index];
  uint32_t size = PATH_MAX;
  char path[PATH_MAX];
  if (_NSGetExecutablePath(path, &size) == 0)
    child_argv[0] = path;
  if (posix_spawn(&gChild, child_argv[0], NULL, &attributes, child_argv,
                  environ) != 0) {
    fprintf(stderr, "voice-input: cannot re-spawn itself\n");
    return 1;
  }
  posix_spawnattr_destroy(&attributes);
  signal(SIGTERM, forward_signal);
  signal(SIGINT, forward_signal);
  signal(SIGHUP, forward_signal);
  int status = 0;
  while (waitpid(gChild, &status, 0) < 0 && errno == EINTR) {
  }
  free(child_argv);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}

static void emit(NSDictionary *object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                 options:0
                                                   error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void fail(NSString *code, NSString *message, int status) {
  emit(@{@"error" : code, @"message" : message});
  exit(status);
}

static void authorize(void (^then)(void)) {
  [SFSpeechRecognizer
      requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
        if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
          fail(@"speech-recognition-denied",
               @"Allow voice-input under System Settings > Privacy & Security "
               @"> Speech Recognition.",
               2);
        }
        then();
      }];
}

static NSString *canonical_locale(NSString *identifier) {
  return [identifier stringByReplacingOccurrencesOfString:@"_" withString:@"-"];
}

// The locale a recognizer exists for that best matches `wanted`: the same
// identifier, else the same language in the Mac's region, else the first one
// of that language.
static NSString *supported_match(NSString *wanted) {
  NSMutableArray<NSString *> *supported = [NSMutableArray array];
  for (NSLocale *locale in [SFSpeechRecognizer supportedLocales])
    [supported addObject:canonical_locale(locale.localeIdentifier)];
  NSString *exact = canonical_locale(wanted);
  for (NSString *candidate in supported)
    if ([candidate caseInsensitiveCompare:exact] == NSOrderedSame)
      return candidate;
  NSString *language =
      [[exact componentsSeparatedByString:@"-"].firstObject lowercaseString];
  NSString *region = [NSLocale currentLocale].countryCode;
  if (region.length > 0) {
    NSString *local = [NSString stringWithFormat:@"%@-%@", language, region];
    for (NSString *candidate in supported)
      if ([candidate caseInsensitiveCompare:local] == NSOrderedSame)
        return candidate;
  }
  NSArray<NSString *> *sorted =
      [supported sortedArrayUsingSelector:@selector(compare:)];
  for (NSString *candidate in sorted)
    if ([[candidate componentsSeparatedByString:@"-"].firstObject
            caseInsensitiveCompare:language] == NSOrderedSame)
      return candidate;
  return nil;
}

// "auto" (or nothing): the Mac's preferred languages, at most three.
static NSArray<NSString *> *resolve_locales(NSString *option) {
  NSArray<NSString *> *wanted =
      option.length == 0 || [option isEqualToString:@"auto"]
          ? [NSLocale preferredLanguages]
          : [option componentsSeparatedByString:@","];
  NSMutableOrderedSet<NSString *> *locales = [NSMutableOrderedSet orderedSet];
  for (NSString *entry in wanted) {
    NSString *trimmed = [entry
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    if (trimmed.length == 0)
      continue;
    NSString *match = supported_match(trimmed);
    if (match != nil)
      [locales addObject:match];
    if (locales.count == 3)
      break;
  }
  return locales.array;
}

// One recognizer per language, all fed the same audio.
@interface Lane : NSObject
@property(nonatomic, strong) SFSpeechRecognizer *recognizer;
@property(nonatomic, copy) NSString *locale;
@property(nonatomic, strong) SFSpeechRecognitionRequest *request;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic, copy) NSString *text;
@property(nonatomic) double confidence;
@property(nonatomic) BOOL done;
@end
@implementation Lane
@end

static NSArray<Lane *> *make_lanes(NSString *option) {
  NSMutableArray<Lane *> *lanes = [NSMutableArray array];
  NSArray<NSString *> *locales = resolve_locales(option);
  for (NSString *locale in locales) {
    SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc]
        initWithLocale:[NSLocale localeWithLocaleIdentifier:locale]];
    if (recognizer == nil || !recognizer.isAvailable)
      continue;
    recognizer.defaultTaskHint = SFSpeechRecognitionTaskHintDictation;
    Lane *lane = [[Lane alloc] init];
    lane.recognizer = recognizer;
    lane.locale = locale;
    [lanes addObject:lane];
  }
  if (lanes.count == 0) {
    SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] init];
    if (recognizer == nil || !recognizer.isAvailable) {
      fail(@"recognizer-unavailable",
           [NSString stringWithFormat:@"No speech recognizer for locale %@.",
                                      option.length > 0 ? option : @"(system)"],
           1);
    }
    Lane *lane = [[Lane alloc] init];
    lane.recognizer = recognizer;
    lane.locale = canonical_locale(recognizer.locale.localeIdentifier);
    [lanes addObject:lane];
  }
  return lanes;
}

static double mean_confidence(SFTranscription *transcription) {
  if (transcription.segments.count == 0)
    return 0;
  double total = 0;
  for (SFTranscriptionSegment *segment in transcription.segments)
    total += segment.confidence;
  return total / (double)transcription.segments.count;
}

// The best-heard transcript: highest mean confidence, then the longest.
static Lane *best_lane(NSArray<Lane *> *lanes) {
  Lane *best = lanes.firstObject;
  for (Lane *lane in lanes) {
    if (lane.confidence > best.confidence ||
        (lane.confidence == best.confidence &&
         lane.text.length > best.text.length))
      best = lane;
  }
  return best;
}

// Starts one recognition task per lane on its request (already set). `onDone`
// runs once on the main queue when every lane has a final result or failed.
static void run_lanes(NSArray<Lane *> *lanes, BOOL partials,
                      void (^onDone)(void)) {
  __block BOOL reported = NO;
  void (^check)(void) = ^{
    if (reported)
      return;
    for (Lane *lane in lanes)
      if (!lane.done)
        return;
    reported = YES;
    onDone();
  };
  for (Lane *lane in lanes) {
    lane.text = @"";
    lane.confidence = 0;
    lane.done = NO;
    if (lane.recognizer.supportsOnDeviceRecognition)
      lane.request.requiresOnDeviceRecognition = YES;
    lane.request.shouldReportPartialResults = partials;
    lane.request.addsPunctuation = YES;
    lane.task = [lane.recognizer
        recognitionTaskWithRequest:lane.request
                     resultHandler:^(SFSpeechRecognitionResult *result,
                                     NSError *error) {
                       dispatch_async(dispatch_get_main_queue(), ^{
                         if (lane.done)
                           return;
                         if (result != nil) {
                           lane.text = result.bestTranscription.formattedString;
                           if (partials) {
                             // Show the language that has heard the most.
                             Lane *leader = lane;
                             for (Lane *other in lanes)
                               if (other.text.length > leader.text.length)
                                 leader = other;
                             if (leader == lane)
                               emit(@{
                                 @"partial" : lane.text,
                                 @"locale" : lane.locale
                               });
                           }
                           if (result.isFinal) {
                             lane.confidence =
                                 mean_confidence(result.bestTranscription);
                             lane.done = YES;
                           }
                         }
                         if (error != nil)
                           lane.done = YES;
                         check();
                       });
                     }];
  }
}

static void report(NSArray<Lane *> *lanes) {
  Lane *best = best_lane(lanes);
  emit(@{@"text" : best.text ?: @"", @"locale" : best.locale ?: @""});
}

static void transcribe_file(NSString *path, NSString *localeOption) {
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    fail(@"file-not-found",
         [NSString stringWithFormat:@"No audio file at %@.", path], 1);
  }
  authorize(^{
    dispatch_async(dispatch_get_main_queue(), ^{
      NSArray<Lane *> *lanes = make_lanes(localeOption);
      for (Lane *lane in lanes)
        lane.request = [[SFSpeechURLRecognitionRequest alloc]
            initWithURL:[NSURL fileURLWithPath:path]];
      run_lanes(lanes, NO, ^{
        BOOL heard = NO;
        for (Lane *lane in lanes)
          heard = heard || lane.text.length > 0;
        if (!heard)
          fail(@"recognition-failed", @"No speech was recognized.", 1);
        report(lanes);
        exit(0);
      });
    });
  });
}

// Microphone sessions. All state is touched on the main queue only.
static NSArray<Lane *> *gLanes;
static AVAudioEngine *gEngine;
static BOOL gListening = NO;
static BOOL gServe = NO;
// Whether the person is holding the key: --mic starts held; --serve follows
// "start" and "stop" lines, which can arrive before setup is done.
static BOOL gWanted = YES;
static double gMaxSeconds = 60;
static NSUInteger gSession = 0;

static void session_finished(NSUInteger session) {
  if (session != gSession)
    return;
  gSession++;
  report(gLanes);
  if (!gServe)
    exit(0);
}

static void stop_listening(void) {
  if (!gListening)
    return;
  gListening = NO;
  [gEngine stop];
  [gEngine.inputNode removeTapOnBus:0];
  for (Lane *lane in gLanes)
    [(SFSpeechAudioBufferRecognitionRequest *)lane.request endAudio];
  // Final results normally arrive within a few hundred milliseconds of
  // endAudio; keep what was heard if one does not.
  NSUInteger session = gSession;
  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)),
      dispatch_get_main_queue(), ^{
        if (session != gSession)
          return;
        for (Lane *lane in gLanes)
          [lane.task cancel];
        session_finished(session);
      });
}

static void start_listening(void) {
  if (gListening)
    return;
  gListening = YES;
  NSMutableArray<SFSpeechAudioBufferRecognitionRequest *> *requests =
      [NSMutableArray array];
  for (Lane *lane in gLanes) {
    SFSpeechAudioBufferRecognitionRequest *request =
        [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    lane.request = request;
    [requests addObject:request];
  }
  NSUInteger session = gSession;
  run_lanes(gLanes, YES, ^{
    if (!gListening)
      session_finished(session);
  });
  NSArray<SFSpeechAudioBufferRecognitionRequest *> *feed = [requests copy];
  AVAudioInputNode *input = gEngine.inputNode;
  [input
      installTapOnBus:0
           bufferSize:1024
               format:[input outputFormatForBus:0]
                block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
                  (void)when;
                  for (SFSpeechAudioBufferRecognitionRequest *request in feed)
                    [request appendAudioPCMBuffer:buffer];
                }];
  NSError *error = nil;
  [gEngine prepare];
  if (![gEngine startAndReturnError:&error]) {
    fail(@"microphone-unavailable",
         error.localizedDescription ?: @"Audio engine did not start.", 1);
  }
  emit(@{@"listening" : @YES});
  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)(gMaxSeconds * NSEC_PER_SEC)),
      dispatch_get_main_queue(), ^{
        if (session == gSession)
          stop_listening();
      });
}

// stdin closed or a signal: finish the question being heard, then exit. Not
// set up yet: the ready handler sees nothing is wanted and exits.
static void end_process(void) {
  BOOL served = gServe;
  gServe = NO;
  gWanted = NO;
  if (gListening)
    stop_listening();
  else if (served && gLanes != nil)
    exit(0);
}

static void listen_microphone(NSString *localeOption) {
  authorize(^{
    [AVCaptureDevice
        requestAccessForMediaType:AVMediaTypeAudio
                completionHandler:^(BOOL granted) {
                  if (!granted) {
                    fail(@"microphone-denied",
                         @"Allow voice-input under System Settings > Privacy & "
                         @"Security > Microphone.",
                         2);
                  }
                  dispatch_async(dispatch_get_main_queue(), ^{
                    gLanes = make_lanes(localeOption);
                    gEngine = [[AVAudioEngine alloc] init];
                    // Touching the input node now builds the audio graph, so
                    // a served "start" only has to switch the engine on.
                    (void)[gEngine.inputNode outputFormatForBus:0];
                    NSMutableArray<NSString *> *locales =
                        [NSMutableArray array];
                    for (Lane *lane in gLanes)
                      [locales addObject:lane.locale];
                    emit(@{@"ready" : @YES, @"locales" : locales});
                    if (gWanted) {
                      start_listening();
                    } else if (!gServe) {
                      // Released before the microphone was ready.
                      emit(@{@"text" : @"", @"locale" : @""});
                      exit(0);
                    }
                  });
                }];
  });
  // --mic: releasing the push-to-talk key closes stdin. --serve: "start" and
  // "stop" lines drive sessions and closing stdin ends the process.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    char buffer[256];
    NSMutableString *pending = [NSMutableString string];
    ssize_t count;
    while ((count = read(STDIN_FILENO, buffer, sizeof buffer)) > 0) {
      if (!gServe)
        continue;
      [pending
          appendString:[[NSString alloc] initWithBytes:buffer
                                                length:(NSUInteger)count
                                              encoding:NSUTF8StringEncoding]
                           ?: @""];
      NSRange newline;
      while ((newline = [pending rangeOfString:@"\n"]).location != NSNotFound) {
        NSString *line = [[pending substringToIndex:newline.location]
            stringByTrimmingCharactersInSet:NSCharacterSet
                                                .whitespaceCharacterSet];
        [pending deleteCharactersInRange:NSMakeRange(0, newline.location + 1)];
        dispatch_async(dispatch_get_main_queue(), ^{
          if ([line isEqualToString:@"start"]) {
            gWanted = YES;
            if (gLanes != nil)
              start_listening();
          } else if ([line isEqualToString:@"stop"]) {
            BOOL starting = gWanted && gLanes == nil;
            gWanted = NO;
            if (gListening)
              stop_listening();
            else if (starting)
              emit(@{@"text" : @"", @"locale" : @""});
          }
        });
      }
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      end_process();
    });
  });
  for (int signal_number = SIGINT; signal_number <= SIGTERM;
       signal_number += SIGTERM - SIGINT) {
    signal(signal_number, SIG_IGN);
    dispatch_source_t source = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)signal_number, 0,
        dispatch_get_main_queue());
    dispatch_source_set_event_handler(source, ^{
      end_process();
    });
    dispatch_resume(source);
    CFBridgingRetain(source);
  }
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (getenv(kResponsibleStage) == NULL)
      return respawn_disclaimed(argc, argv);
    NSString *file = nil;
    NSString *locale = nil;
    BOOL microphone = NO;
    for (int index = 1; index < argc; index++) {
      NSString *argument = @(argv[index]);
      NSString *value = index + 1 < argc ? @(argv[index + 1]) : nil;
      if ([argument isEqualToString:@"--file"] && value) {
        file = value;
        index++;
      } else if ([argument isEqualToString:@"--locale"] && value) {
        locale = value;
        index++;
      } else if ([argument isEqualToString:@"--max-seconds"] && value) {
        gMaxSeconds = MAX(1, MIN(300, value.doubleValue));
        index++;
      } else if ([argument isEqualToString:@"--mic"]) {
        microphone = YES;
      } else if ([argument isEqualToString:@"--serve"]) {
        microphone = YES;
        gServe = YES;
      } else {
        fail(@"usage",
             @"voice-input --file <audio> | --mic | --serve [--max-seconds n] "
             @"[--locale auto|id[,id...]]",
             64);
      }
    }
    if ((file != nil) == microphone)
      fail(@"usage", @"Pass exactly one of --file <audio>, --mic or --serve.",
           64);
    if (file != nil) {
      transcribe_file(file, locale);
    } else {
      listen_microphone(locale);
    }
    dispatch_main();
  }
}
