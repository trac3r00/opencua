#import <Cocoa/Cocoa.h>

// Exercise the pure marker stacking decision without opening any window or
// touching the window server.
#define main CursorOverlayMain
#include "../cursor-overlay.m"
#undef main

static NSDictionary *entry(int pid, int layer, unsigned int number,
                           CGRect bounds) {
  return @{
    (__bridge NSString *)kCGWindowOwnerPID : @(pid),
    (__bridge NSString *)kCGWindowLayer : @(layer),
    (__bridge NSString *)kCGWindowNumber : @(number),
    (__bridge NSString *)kCGWindowBounds :
        CFBridgingRelease(CGRectCreateDictionaryRepresentation(bounds)),
  };
}

int main(void) {
  @autoreleasepool {
    CGRect main = CGRectMake(100, 100, 800, 600);
    CGRect dialog = CGRectMake(300, 200, 300, 150);
    CGRect side = CGRectMake(1000, 100, 400, 400);
    // Front to back: the user's window, the target's status-level panel, then
    // the target's dialog, main window and a window off to the side.
    NSArray *stack = @[
      entry(10, 0, 5, main), entry(20, 25, 6, main), entry(20, 0, 7, dialog),
      entry(20, 0, 8, main), entry(20, 0, 11, side)
    ];
    NSArray *malformed = @[
      @{(__bridge NSString *)kCGWindowOwnerPID : @(20)},
      @{
        (__bridge NSString *)kCGWindowOwnerPID : @"20",
        (__bridge NSString *)kCGWindowLayer : @(0),
        (__bridge NSString *)kCGWindowNumber : @(3),
      },
      entry(20, 0, 0, main), entry(20, 0, 9, main)
    ];
    NSRect cursorInDialog = NSMakeRect(400, 250, 20, 20);
    NSRect cursorInMainOnly = NSMakeRect(150, 650, 20, 20);
    NSRect cursorInSide = NSMakeRect(1100, 200, 20, 20);
    NSRect cursorNowhere = NSMakeRect(2000, 2000, 20, 20);
    NSRect closedDialogFrame = NSMakeRect(320, 220, 300, 150);
    printf("cursor-dialog=%u\n",
           marker_target_window(stack, 20, cursorInDialog, NO));
    printf("cursor-main=%u\n",
           marker_target_window(stack, 20, cursorInMainOnly, NO));
    printf("cursor-side=%u\n",
           marker_target_window(stack, 20, cursorInSide, NO));
    printf("cursor-outside=%u\n",
           marker_target_window(stack, 20, cursorNowhere, NO));
    printf("frame-main=%u\n", marker_target_window(stack, 20, main, YES));
    printf("frame-closed=%u\n",
           marker_target_window(stack, 20, closedDialogFrame, YES));
    printf("absent=%u\n", marker_target_window(stack, 30, main, NO));
    printf("user-front=%u\n", marker_target_window(stack, 10, main, NO));
    printf("empty=%u\n", marker_target_window(@[], 20, main, NO));
    printf("zero-pid=%u\n",
           marker_target_window(@[ entry(0, 0, 4, main) ], 0, main, NO));
    printf("malformed=%u\n", marker_target_window(malformed, 20, main, NO));
  }
  return 0;
}
