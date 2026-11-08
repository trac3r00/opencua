/**
 * Drag and drop between two owned surfaces (two pages that never share a window or a drag session).
 * The source page runs its own dragstart at the pick-up point, so whatever the page puts in its
 * DataTransfer (text, URLs, HTML; a dragged image or link adds its URL) is read out; the destination
 * page then gets dragenter, dragover and drop at the drop point with a DataTransfer holding the same
 * items. Files are not carried: pages cannot read dragged files back out of a synthetic drag.
 */
export const DRAG_BRIDGE_SCRIPT = String.raw`(() => {
  if (window.__opencuaDragOut) return;
  const options = (x, y, data) => ({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: data });
  window.__opencuaDragOut = (x, y) => {
    const target = document.elementFromPoint(x, y);
    if (!target) return JSON.stringify({ items: {} });
    const data = new DataTransfer();
    const source = target.closest("[draggable=true], a[href], img[src]") || target;
    if (source instanceof HTMLImageElement) data.setData("text/uri-list", source.currentSrc || source.src);
    else if (source instanceof HTMLAnchorElement) { data.setData("text/uri-list", source.href); data.setData("text/plain", source.href); }
    source.dispatchEvent(new DragEvent("dragstart", options(x, y, data)));
    const items = {};
    for (const type of data.types) if (type !== "Files") items[type] = data.getData(type);
    source.dispatchEvent(new DragEvent("dragend", options(x, y, data)));
    return JSON.stringify({ items });
  };
  window.__opencuaDropIn = (x, y, json) => {
    const target = document.elementFromPoint(x, y);
    if (!target) return false;
    const payload = JSON.parse(json);
    const data = new DataTransfer();
    for (const [type, value] of Object.entries(payload.items || {})) if (typeof value === "string") data.setData(type, value);
    target.dispatchEvent(new DragEvent("dragenter", options(x, y, data)));
    const over = new DragEvent("dragover", options(x, y, data));
    target.dispatchEvent(over);
    if (!over.defaultPrevented) { target.dispatchEvent(new DragEvent("dragleave", options(x, y, data))); return false; }
    target.dispatchEvent(new DragEvent("drop", options(x, y, data)));
    return true;
  };
})()`;

export interface DragPayload {
	readonly items: Readonly<Record<string, string>>;
}

export function readDragPayload(json: unknown): DragPayload {
	if (typeof json !== "string") throw new Error("drag source returned no payload");
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || !("items" in parsed))
		throw new Error("drag payload has no items");
	const items: unknown = parsed.items;
	if (typeof items !== "object" || items === null || Array.isArray(items))
		throw new Error("drag payload items are not a map");
	const carried: Record<string, string> = {};
	for (const [type, value] of Object.entries(items)) {
		if (typeof value === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(type)) carried[type] = value;
	}
	return { items: carried };
}

/** Page calls for one cross-surface drag; the caller evaluates them on the source and destination pages. */
export function dragOutCall(x: number, y: number): string {
	return `window.__opencuaDragOut(${Number(x)}, ${Number(y)})`;
}

export function dropInCall(x: number, y: number, payload: DragPayload): string {
	return `window.__opencuaDropIn(${Number(x)}, ${Number(y)}, ${JSON.stringify(JSON.stringify(payload))})`;
}
