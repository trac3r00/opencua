#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#include <spawn.h>

// Keep the real launch handler, but never request or install a host event tap.
static unsigned int gOfflineTapRequests = 0;
static CFMachPortRef
OfflineEventTapCreate(CGEventTapLocation tap, CGEventTapPlacement place,
                      CGEventTapOptions options, CGEventMask mask,
                      CGEventTapCallBack callback, void *info) {
  (void)tap;
  (void)place;
  (void)options;
  (void)mask;
  (void)callback;
  (void)info;
  gOfflineTapRequests += 1;
  return NULL;
}

// Seconds past 2026-11-01T12:00:00Z; text-run cases advance it.
static time_t gOfflineClock = 0;
static time_t OfflineTime(time_t *destination) {
  const time_t now = 1793534400 + gOfflineClock; // 2026-11-01T12:00:00Z
  if (destination != NULL) {
    *destination = now;
  }
  return now;
}

// Launcher children are printed, never started.
static int gOfflineDisclaim = -1;
static int OfflineDisclaim(posix_spawnattr_t *attributes, int disclaim) {
  (void)attributes;
  gOfflineDisclaim = disclaim;
  return 0;
}
static int OfflineSpawn(pid_t *pid, const char *path,
                        const posix_spawn_file_actions_t *files,
                        const posix_spawnattr_t *attributes, char *const argv[],
                        char *const envp[]) {
  (void)files;
  (void)attributes;
  (void)envp;
  printf("spawn disclaim=%d %s", gOfflineDisclaim, path);
  for (int index = 1; argv[index] != NULL; index++) {
    printf(" %s", argv[index]);
  }
  printf("\n");
  *pid = getpid(); // not a child: the reaper's waitpid fails at once
  return 0;
}

// Alerts are answered here instead of shown.
static NSModalResponse gOfflineAlertAnswer = NSAlertSecondButtonReturn;
@interface OfflineAlert : NSObject
@property(copy) NSString *messageText;
@property(copy) NSString *informativeText;
@property NSAlertStyle alertStyle;
- (id)addButtonWithTitle:(NSString *)title;
- (NSModalResponse)runModal;
@end
@implementation OfflineAlert
- (id)addButtonWithTitle:(NSString *)title {
  (void)title;
  return nil;
}
- (NSModalResponse)runModal {
  printf("alert %s\n", self.messageText.UTF8String);
  return gOfflineAlertAnswer;
}
@end

#define time OfflineTime
#define CGEventTapCreate OfflineEventTapCreate
#define responsibility_spawnattrs_setdisclaim OfflineDisclaim
#define posix_spawn OfflineSpawn
#define NSAlert OfflineAlert
#define NSApp ((NSApplication *)nil)
#define main HistoryRecorderMain
#include "../history-recorder.m"
#undef main
#undef NSApp
#undef NSAlert
#undef posix_spawn
#undef responsibility_spawnattrs_setdisclaim
#undef CGEventTapCreate
#undef time

@interface OfflineHistoryDelegate : HistoryRecorderDelegate
@end

@implementation OfflineHistoryDelegate
- (void)buildStatusItem {
}
- (void)refreshStatusTitle {
}
@end

static void PrintMenu(NSMenu *menu, NSString *indent) {
  for (NSMenuItem *item in menu.itemArray) {
    if (item.isSeparatorItem) {
      printf("%s---\n", indent.UTF8String);
      continue;
    }
    NSString *represented =
        [item.representedObject isKindOfClass:NSString.class]
            ? [@" " stringByAppendingString:item.representedObject]
            : @"";
    printf("%s%s|%s%s\n", indent.UTF8String, item.title.UTF8String,
           item.action == NULL ? ""
                               : NSStringFromSelector(item.action).UTF8String,
           represented.UTF8String);
    if (item.submenu != nil && item.submenu != gSuggestionsMenu) {
      PrintMenu(item.submenu, [indent stringByAppendingString:@"  "]);
    }
  }
}

static void Choose(NSMenuItem *item) {
  void (*action)(id, SEL, id) =
      (void (*)(id, SEL, id))[item.target methodForSelector:item.action];
  action(item.target, item.action, item);
}

static NSMenuItem *ItemTitled(NSMenu *menu, NSString *title) {
  for (NSMenuItem *item in menu.itemArray) {
    if ([item.title isEqualToString:title]) {
      return item;
    }
    NSMenuItem *nested =
        item.submenu == nil ? nil : ItemTitled(item.submenu, title);
    if (nested != nil) {
      return nested;
    }
  }
  return nil;
}

static void Type(NSDictionary *app, AXUIElementRef element,
                 NSDictionary *context, NSString *keys) {
  [keys
      enumerateSubstringsInRange:NSMakeRange(0, keys.length)
                         options:NSStringEnumerationByComposedCharacterSequences
                      usingBlock:^(NSString *key, NSRange range,
                                   NSRange enclosing, BOOL *stop) {
                        (void)range;
                        (void)enclosing;
                        (void)stop;
                        HandleTypedKey(app, key, element, ^NSDictionary * {
                          return context;
                        });
                      }];
}

static NSString *JSONText(id value) {
  if (value == nil) {
    return @"null";
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:value
                                                 options:NSJSONWritingSortedKeys
                                                   error:NULL];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) {
      return 2;
    }
    NSString *mode = [NSString stringWithUTF8String:argv[1]];
    NSString *root = [NSString stringWithUTF8String:argv[2]];
    @try {
      if ([mode isEqualToString:@"prune"]) {
        gSegmentsDir = [root stringByAppendingPathComponent:@"segments"];
        // 2026-11-01T12:00:00Z. Do not depend on the machine clock.
        PruneOldSegments(1793534400);
      } else if ([mode isEqualToString:@"menu"]) {
        gRoot = [root stringByAppendingPathComponent:@"cua-history"];
        PrintMenu([[[OfflineHistoryDelegate alloc] init] buildMenu], @"");
        return 0;
      } else if ([mode isEqualToString:@"launcher"]) {
        gRoot = [root stringByAppendingPathComponent:@"cua-history"];
        OfflineHistoryDelegate *delegate =
            [[OfflineHistoryDelegate alloc] init]; // menu targets are weak
        NSMenu *menu = [delegate buildMenu];
        for (NSString *title in @[
               @"Open timeline", @"Stop buddy talking", @"Buddy settings\u2026"
             ]) {
          Choose(ItemTitled(menu, title));
        }
        gOfflineAlertAnswer = NSAlertSecondButtonReturn;
        Choose(ItemTitled(menu, @"Last hour"));
        gOfflineAlertAnswer = NSAlertFirstButtonReturn;
        Choose(ItemTitled(menu, @"Last 10 minutes"));
        Choose(ItemTitled(menu, @"All"));
        return 0;
      } else if ([mode isEqualToString:@"fields"]) {
        NSString *longTitle = [@"" stringByPaddingToLength:300
                                                withString:@"t"
                                           startingAtIndex:0];
        printf("%s\n", JSONText(ElementFields(@[
                         @"AXTextField", NSNull.null, longTitle, @" Search ",
                         @"q", @"Search mail", NSNull.null, NSNull.null
                       ]))
                           .UTF8String);
        printf("%s\n", JSONText(ElementFields(@[
                         NSNull.null, @"AXSecureTextField", @"", @"", @"", @""
                       ]))
                           .UTF8String);
        printf("%s\n",
               JSONText(DocumentFields(@"file:///Users/me/Notes/plan.txt", nil))
                   .UTF8String);
        printf("%s\n",
               JSONText(
                   DocumentFields(
                       nil,
                       [NSURL URLWithString:@"https://example.com/inbox?x=1"]))
                   .UTF8String);
        printf("%s\n",
               JSONText(DocumentFields(@"not a url", NSNull.null)).UTF8String);
        printf(
            "%d %d %d\n",
            IsSecureElement(
                @{@"role" : @"AXTextField", @"subrole" : @"AXSecureTextField"}),
            IsSecureElement(@{@"role" : @"AXSecureTextField"}),
            IsSecureElement(@{@"role" : @"AXTextField"}));
        printf("%s %s\n",
               JSONText(ModifierNames(kCGEventFlagMaskCommand |
                                      kCGEventFlagMaskShift |
                                      kCGEventFlagMaskAlternate |
                                      kCGEventFlagMaskControl))
                   .UTF8String,
               JSONText(ModifierNames(kCGEventFlagMaskControl |
                                      kCGEventFlagMaskAlphaShift))
                   .UTF8String);
        return 0;
      } else if ([mode isEqualToString:@"text-runs"]) {
        gRoot = [root stringByAppendingPathComponent:@"cua-history"];
        gSegmentsDir = [gRoot stringByAppendingPathComponent:@"segments"];
        gSettingsPath = [gRoot stringByAppendingPathComponent:@"settings.json"];
        gAllowBundleIds = [NSMutableSet set];
        gBlockBundleIds = [NSMutableSet set];
        LoadSettings();
        EnsureDir(gSegmentsDir);
        NSDictionary *notes = @{
          @"bundleIdentifier" : @"com.example.Notes",
          @"name" : @"Notes",
          @"processIdentifier" : @4242
        };
        NSDictionary *other = @{
          @"bundleIdentifier" : @"com.example.Other",
          @"name" : @"Other",
          @"processIdentifier" : @4343
        };
        NSDictionary *window = @{@"title" : @"Plan", @"windowID" : @512};
        NSDictionary *document = @{@"path" : @"/Users/me/Notes/plan.txt"};
        AXUIElementRef titleField = AXUIElementCreateApplication(91001);
        AXUIElementRef body = AXUIElementCreateApplication(91002);
        AXUIElementRef password = AXUIElementCreateApplication(91003);
        NSDictionary *titleContext = @{
          @"element" : @{@"role" : @"AXTextField", @"placeholder" : @"Title"},
          @"window" : window,
          @"document" : document
        };
        NSDictionary *bodyContext = @{
          @"element" : @{@"role" : @"AXTextArea", @"description" : @"Body"},
          @"window" : window
        };
        NSDictionary *passwordContext = @{
          @"element" :
              @{@"role" : @"AXTextField", @"subrole" : @"AXSecureTextField"},
          @"window" : window
        };
        // A run keeps its first key's time; Backspace edits it; a dead key adds
        // nothing; Return ends it.
        Type(notes, titleField, titleContext, @"H");
        gOfflineClock = 5;
        Type(notes, titleField, titleContext, @"i");
        HandleTypedKey(notes, @"", titleField, ^NSDictionary * {
          return titleContext;
        });
        Type(notes, titleField, titleContext, @"\x7fo!\r");
        // Another element ends a run; a secure field is never written.
        gOfflineClock = 10;
        Type(notes, body, bodyContext, @"ab");
        Type(notes, password, passwordContext, @"hunter2");
        // A field AX cannot name may be a password field: its text is never
        // written either.
        Type(notes, NULL, @{@"window" : window}, @"unnamed-secret");
        Type(notes, body, bodyContext, @"c");
        RecordInput(@"mouse.click", notes, @"mouse", @{@"button" : @"left"},
                    bodyContext);
        // Two seconds without typing end a run.
        gOfflineClock = 20;
        Type(notes, body, bodyContext, @"d");
        gRunLastKey -= kTextRunIdleSeconds + 1;
        gOfflineClock = 23;
        Type(notes, body, bodyContext, @"e");
        RecordInput(@"keyboard.shortcut", notes, @"keyboard", @{
          @"keyEquivalent" : @"s",
          @"modifiers" : ModifierNames(kCGEventFlagMaskCommand)
        },
                    bodyContext);
        // An arrow key ends a run; Backspace with nothing pending is not text.
        gOfflineClock = 30;
        Type(notes, body, bodyContext, @"\x7f");
        Type(notes, body, bodyContext, @"f\uF702g");
        FlushTextRun();
        // Typing in an app excluded before the run ends is dropped.
        Type(other, NULL, @{}, @"secret");
        [gBlockBundleIds addObject:@"com.example.other"];
        FlushTextRun();
        CFRelease(titleField);
        CFRelease(body);
        CFRelease(password);
        printf("%ld\n", gCurrentEventCount);
        return 0;
      } else if ([mode isEqualToString:@"menubar"]) {
        // Hold the menu bar lock as the running recorder does, until stdin
        // closes.
        AcquireMenubarLock(root);
        printf("%s\n", gMenubarLock >= 0 ? "held" : "busy");
        fflush(stdout);
        char buffer[16];
        while (fread(buffer, 1, sizeof(buffer), stdin) > 0) {
        }
        return 0;
      } else if ([mode isEqualToString:@"exclude"]) {
        gRoot = [root stringByAppendingPathComponent:@"cua-history"];
        gSettingsPath = [gRoot stringByAppendingPathComponent:@"settings.json"];
        gAllowBundleIds = [NSMutableSet set];
        gBlockBundleIds = [NSMutableSet set];
        LoadSettings();
        OfflineHistoryDelegate *delegate =
            [[OfflineHistoryDelegate alloc] init];
        NSMenuItem *item = [[NSMenuItem alloc] init];
        item.representedObject = @"com.example.Notes";
        [delegate excludeFrontApp:item];
        printf("%s %s\n",
               ShouldObserveApp(@"com.example.Notes") ? "observe" : "skip",
               ShouldObserveApp(@"com.example.Other") ? "observe" : "skip");
        return 0;
      } else if ([mode isEqualToString:@"forget-current"]) {
        gRoot = [root stringByAppendingPathComponent:@"cua-history"];
        gSegmentsDir = [gRoot stringByAppendingPathComponent:@"segments"];
        EnsureDir(gSegmentsDir);
        AppendEvent([@{@"kind" : @"session.started"} mutableCopy]);
        AppendEvent([@{@"kind" : @"session.started"} mutableCopy]);
        [NSFileManager.defaultManager
            removeItemAtPath:SegmentDir(gCurrentSegmentId)
                       error:NULL];
        AppendEvent([@{@"kind" : @"session.started"} mutableCopy]);
        printf("%ld\n", gCurrentEventCount);
        return 0;
      } else if ([mode isEqualToString:@"tick"]) {
        gRoot = [root stringByAppendingPathComponent:@"cua-history"];
        gSegmentsDir = [gRoot stringByAppendingPathComponent:@"segments"];
        gStatePath = [gRoot stringByAppendingPathComponent:@"state.json"];
        gSettingsPath = [gRoot stringByAppendingPathComponent:@"settings.json"];
        OfflineHistoryDelegate *delegate =
            [[OfflineHistoryDelegate alloc] init];
        [delegate tick:nil];
      } else if ([mode isEqualToString:@"startup"] ||
                 [mode isEqualToString:@"policy"] ||
                 [mode isEqualToString:@"revoke"]) {
        OfflineHistoryDelegate *delegate =
            [[OfflineHistoryDelegate alloc] init];
        [delegate
            applicationDidFinishLaunching:
                [NSNotification notificationWithName:
                                    NSApplicationDidFinishLaunchingNotification
                                              object:nil]];
        if ([mode isEqualToString:@"policy"]) {
          [delegate resume:nil];
        } else if ([mode isEqualToString:@"revoke"]) {
          NSData *next = [NSData
              dataWithContentsOfFile:
                  [root stringByAppendingPathComponent:@"next-settings.json"]];
          [next writeToFile:gSettingsPath atomically:YES];
          [delegate tick:nil];
        }
      } else {
        return 2;
      }
    } @catch (NSException *exception) {
      fprintf(stderr, "%s: %s\n", exception.name.UTF8String,
              exception.reason.UTF8String);
      return 1;
    }
    printf("%u\n", gOfflineTapRequests);
  }
  return 0;
}
