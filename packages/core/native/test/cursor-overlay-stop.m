#import <Cocoa/Cocoa.h>

// Drive the real menu bar menu without creating a status item or any window:
// build the same NSMenu the helper shows, read its titles and enabled states,
// and fire its items through AppKit's own action dispatch.
#define main CursorOverlayMain
#include "../cursor-overlay.m"
#undef main

static void print_menu(NSMenu *menu) {
  for (NSMenuItem *item in menu.itemArray) {
    if (item.isSeparatorItem) {
      printf("---\n");
    } else {
      printf("%s|%s\n", item.title.UTF8String, item.enabled ? "on" : "off");
    }
  }
}

static NSInteger index_of(NSMenu *menu, NSString *title) {
  return [menu indexOfItemWithTitle:title];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "visible") == 0) {
      // Decide visibility as a status-only helper does, then keep any lock it
      // took until stdin closes, like a helper whose server is still alive.
      printf("%s\n", stop_menu_visible() ? "shown" : "hidden");
      fflush(stdout);
      char buffer[16];
      while (fread(buffer, 1, sizeof(buffer), stdin) > 0) {
      }
      return 0;
    }
    if (argc == 2 && strcmp(argv[1], "drawing") == 0) {
      // Decide as a drawing overlay does whether it adds its own item.
      printf("%s\n", drawing_status_visible() ? "shown" : "hidden");
      fflush(stdout);
      char buffer[16];
      while (fread(buffer, 1, sizeof(buffer), stdin) > 0) {
      }
      return 0;
    }
    if (argc != 2 || strcmp(argv[1], "menu") != 0) {
      return 2;
    }
    [NSApplication sharedApplication];
    NSMenu *menu =
        control_menu(nil, status_only_lines(stop_engaged()), stop_engaged());
    printf("== initial\n");
    print_menu(menu);
    [menu performActionForItemAtIndex:index_of(menu, @"Stop all agents")];
    menu =
        control_menu(menu, status_only_lines(stop_engaged()), stop_engaged());
    printf("== after stop (%s)\n", stop_engaged() ? "engaged" : "clear");
    print_menu(menu);
    [menu performActionForItemAtIndex:index_of(menu, @"Resume agents")];
    menu =
        control_menu(menu, status_only_lines(stop_engaged()), stop_engaged());
    printf("== after resume (%s)\n", stop_engaged() ? "engaged" : "clear");
    print_menu(menu);
  }
  return 0;
}
