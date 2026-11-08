// Runs inside an agent-owned macOS guest (never on the host): prints the front window's accessibility tree as JSON,
// frames in screen points, so the isolated server can pair a screenshot with named, located elements.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static CFTypeRef Attr(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = NULL;
  return AXUIElementCopyAttributeValue(element, name, &value) == kAXErrorSuccess ? value : NULL;
}

static NSString *Text(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = Attr(element, name);
  if (value == NULL) return nil;
  NSString *text = CFGetTypeID(value) == CFStringGetTypeID() ? [(__bridge NSString *)value copy] : nil;
  CFRelease(value);
  return text.length > 0 ? text : nil;
}

static NSArray *Frame(AXUIElementRef element) {
  CFTypeRef position = Attr(element, kAXPositionAttribute);
  CFTypeRef size = Attr(element, kAXSizeAttribute);
  CGPoint point = CGPointZero;
  CGSize extent = CGSizeZero;
  BOOL ok = position != NULL && size != NULL && AXValueGetValue(position, kAXValueCGPointType, &point) &&
            AXValueGetValue(size, kAXValueCGSizeType, &extent);
  if (position != NULL) CFRelease(position);
  if (size != NULL) CFRelease(size);
  return ok ? @[ @(lround(point.x)), @(lround(point.y)), @(lround(extent.width)), @(lround(extent.height)) ] : nil;
}

int main(void) {
  @autoreleasepool {
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    AXUIElementRef app = AXUIElementCreateApplication(front.processIdentifier);
    AXUIElementRef window = (AXUIElementRef)Attr(app, kAXFocusedWindowAttribute);
    NSMutableArray *elements = [NSMutableArray array];
    NSMutableArray *queue = [NSMutableArray array];
    if (window != NULL) [queue addObject:@[ (__bridge id)window, @0 ]];
    while (queue.count > 0 && elements.count < 200) {
      NSArray *item = queue.firstObject;
      [queue removeObjectAtIndex:0];
      AXUIElementRef element = (__bridge AXUIElementRef)item[0];
      NSInteger depth = [item[1] integerValue];
      NSMutableDictionary *entry = [NSMutableDictionary dictionaryWithObject:@(depth) forKey:@"depth"];
      entry[@"role"] = Text(element, kAXRoleAttribute);
      entry[@"title"] = Text(element, kAXTitleAttribute) ?: Text(element, kAXDescriptionAttribute);
      NSString *value = Text(element, kAXValueAttribute);
      if (value != nil) entry[@"value"] = value.length > 80 ? [value substringToIndex:80] : value;
      entry[@"frame"] = Frame(element);
      [elements addObject:entry];
      CFTypeRef children = Attr(element, kAXChildrenAttribute);
      if (children != NULL && depth < 12 && CFGetTypeID(children) == CFArrayGetTypeID()) {
        for (id child in (__bridge NSArray *)children) [queue addObject:@[ child, @(depth + 1) ]];
      }
      if (children != NULL) CFRelease(children);
    }
    NSDictionary *out = @{
      @"trusted" : @(AXIsProcessTrusted()),
      @"app" : front.localizedName ?: @"",
      @"window" : @(window != NULL),
      @"screen" : @[ @(NSScreen.mainScreen.frame.size.width), @(NSScreen.mainScreen.frame.size.height) ],
      @"elements" : elements
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:NULL];
    fwrite(json.bytes, 1, json.length, stdout);
    if (window != NULL) CFRelease(window);
    CFRelease(app);
  }
  return 0;
}
