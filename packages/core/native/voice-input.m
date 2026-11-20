// voice-input: speech to text for the opencua buddy (push-to-talk questions and
// agent requests).
//
//   voice-input --file <audio> [--locale ko-KR]   transcribe an audio file
//   voice-input --mic [--max-seconds 60] [--locale ko-KR]
//       listen to the microphone until stdin closes (the push-to-talk key was
//       released), SIGTERM/SIGINT, or the time limit; partial transcripts
//       stream as they arrive
//
// Output is JSON lines on stdout: {"partial":"..."} while listening, then one
// {"text":"..."} line, or
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

static void finish(NSString *text) {
  emit(@{@"text" : text ?: @""});
  exit(0);
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

static SFSpeechRecognizer *make_recognizer(NSString *locale) {
  SFSpeechRecognizer *recognizer =
      locale.length > 0
          ? [[SFSpeechRecognizer alloc]
                initWithLocale:[NSLocale localeWithLocaleIdentifier:locale]]
          : [[SFSpeechRecognizer alloc] init];
  if (recognizer == nil || !recognizer.isAvailable) {
    fail(@"recognizer-unavailable",
         [NSString stringWithFormat:@"No speech recognizer for locale %@.",
                                    locale ?: @"(system)"],
         1);
  }
  return recognizer;
}

static void transcribe_file(NSString *path, NSString *locale) {
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    fail(@"file-not-found",
         [NSString stringWithFormat:@"No audio file at %@.", path], 1);
  }
  authorize(^{
    dispatch_async(dispatch_get_main_queue(), ^{
      SFSpeechRecognizer *recognizer = make_recognizer(locale);
      SFSpeechURLRecognitionRequest *request =
          [[SFSpeechURLRecognitionRequest alloc]
              initWithURL:[NSURL fileURLWithPath:path]];
      if (recognizer.supportsOnDeviceRecognition)
        request.requiresOnDeviceRecognition = YES;
      request.shouldReportPartialResults = NO;
      [recognizer
          recognitionTaskWithRequest:request
                       resultHandler:^(SFSpeechRecognitionResult *result,
                                       NSError *error) {
                         if (result.isFinal)
                           finish(result.bestTranscription.formattedString);
                         if (error != nil)
                           fail(@"recognition-failed",
                                error.localizedDescription, 1);
                       }];
    });
  });
}

static AVAudioEngine *gEngine;
static SFSpeechAudioBufferRecognitionRequest *gRequest;
static NSString *gLatest = @"";
static BOOL gEnding = NO;

static void end_listening(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (gEnding)
      return;
    gEnding = YES;
    [gEngine stop];
    [gEngine.inputNode removeTapOnBus:0];
    [gRequest endAudio];
    // The recognizer delivers its final result shortly after endAudio; keep
    // what was heard if it does not.
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
          finish(gLatest);
        });
  });
}

static void listen_microphone(NSString *locale, double max_seconds) {
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
                    SFSpeechRecognizer *recognizer = make_recognizer(locale);
                    gRequest =
                        [[SFSpeechAudioBufferRecognitionRequest alloc] init];
                    gRequest.shouldReportPartialResults = YES;
                    if (recognizer.supportsOnDeviceRecognition)
                      gRequest.requiresOnDeviceRecognition = YES;
                    gEngine = [[AVAudioEngine alloc] init];
                    AVAudioInputNode *input = gEngine.inputNode;
                    [input installTapOnBus:0
                                bufferSize:1024
                                    format:[input outputFormatForBus:0]
                                     block:^(AVAudioPCMBuffer *buffer,
                                             AVAudioTime *when) {
                                       (void)when;
                                       [gRequest appendAudioPCMBuffer:buffer];
                                     }];
                    [recognizer
                        recognitionTaskWithRequest:gRequest
                                     resultHandler:^(
                                         SFSpeechRecognitionResult *result,
                                         NSError *error) {
                                       if (result != nil) {
                                         gLatest = result.bestTranscription
                                                       .formattedString;
                                         if (result.isFinal)
                                           finish(gLatest);
                                         emit(@{@"partial" : gLatest});
                                       }
                                       if (error != nil && gEnding)
                                         finish(gLatest);
                                     }];
                    NSError *error = nil;
                    [gEngine prepare];
                    if (![gEngine startAndReturnError:&error]) {
                      fail(@"microphone-unavailable",
                           error.localizedDescription
                               ?: @"Audio engine did not start.",
                           1);
                    }
                    emit(@{@"listening" : @YES});
                    dispatch_after(
                        dispatch_time(DISPATCH_TIME_NOW,
                                      (int64_t)(max_seconds * NSEC_PER_SEC)),
                        dispatch_get_main_queue(), ^{
                          end_listening();
                        });
                  });
                }];
  });
  // Releasing the push-to-talk key closes stdin.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    char buffer[256];
    while (read(STDIN_FILENO, buffer, sizeof buffer) > 0) {
    }
    end_listening();
  });
  for (int signal_number = SIGINT; signal_number <= SIGTERM;
       signal_number += SIGTERM - SIGINT) {
    signal(signal_number, SIG_IGN);
    dispatch_source_t source = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)signal_number, 0,
        dispatch_get_main_queue());
    dispatch_source_set_event_handler(source, ^{
      end_listening();
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
    double max_seconds = 60;
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
        max_seconds = MAX(1, MIN(300, value.doubleValue));
        index++;
      } else if ([argument isEqualToString:@"--mic"]) {
        microphone = YES;
      } else {
        fail(@"usage",
             @"voice-input --file <audio> | --mic [--max-seconds n] [--locale "
             @"id]",
             64);
      }
    }
    if ((file != nil) == microphone)
      fail(@"usage", @"Pass exactly one of --file <audio> or --mic.", 64);
    if (file != nil) {
      transcribe_file(file, locale);
    } else {
      listen_microphone(locale, max_seconds);
    }
    dispatch_main();
  }
}
