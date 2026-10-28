import * as Y from "yjs";

/** The kinds of top-level shared type a document can have. */
export type RootKind = "text" | "map" | "array" | "xml";

const CONSTRUCTORS = { text: Y.Text, map: Y.Map, array: Y.Array, xml: Y.XmlFragment } as const;

/** A top-level shared type, as `doc.share` holds it. */
type Root = NonNullable<ReturnType<Y.Doc["share"]["get"]>>;

/**
 * What kind a top-level type is. Apps usually declare their types (`doc.getText("body")`), and
 * then the class says it. A type nobody declared in this doc is a placeholder, so its content
 * decides: keys mean a map; text or formatting means text; XML nodes mean an XML fragment;
 * anything else in a list means an array.
 */
export function rootKind(type: Root): RootKind | undefined {
  if (type instanceof Y.Text) return "text";
  if (type instanceof Y.XmlFragment) return "xml";
  if (type instanceof Y.Map) return "map";
  if (type instanceof Y.Array) return "array";
  let item = type._start;
  let sawList = false;
  while (item) {
    if (!item.deleted) {
      sawList = true;
      const content = item.content;
      if (content instanceof Y.ContentString || content instanceof Y.ContentFormat || content instanceof Y.ContentEmbed) return "text";
      if (content instanceof Y.ContentType && (content.type instanceof Y.XmlElement || content.type instanceof Y.XmlText || content.type instanceof Y.XmlHook)) {
        return "xml";
      }
    }
    item = item.right;
  }
  if (sawList) return "array";
  for (const entry of type._map.values()) if (!entry.deleted) return "map";
  return undefined;
}

function cloneValue(value: unknown): unknown {
  if (value instanceof Y.AbstractType) return value.clone();
  if (value instanceof Uint8Array) return value.slice();
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

const sameValue = (a: unknown, b: unknown) =>
  a === b || (!(a instanceof Y.AbstractType) && !(b instanceof Y.AbstractType) && JSON.stringify(a) === JSON.stringify(b));

function replaceText(target: Y.Text, source: Y.Text): void {
  target.delete(0, target.length);
  const delta = source.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[];
  target.applyDelta(delta.map((op) => ({ ...op, insert: cloneValue(op.insert) })));
}

function replaceMap(target: Y.Map<unknown>, source: Y.Map<unknown>): void {
  for (const key of [...target.keys()]) if (!source.has(key)) target.delete(key);
  for (const [key, value] of source.entries()) {
    if (!sameValue(target.get(key), value)) target.set(key, cloneValue(value));
  }
}

function replaceList(target: Y.Array<unknown> | Y.XmlFragment, source: Y.Array<unknown> | Y.XmlFragment): void {
  target.delete(0, target.length);
  // biome-ignore lint/suspicious/noExplicitAny: Y.Array and Y.XmlFragment take different element types
  (target as Y.Array<any>).insert(0, source.toArray().map(cloneValue));
}

export interface RestoreOptions {
  /**
   * Transaction origin. Pass the one your `Y.UndoManager` tracks (in `trackedOrigins`) to make
   * the restore undoable.
   */
  origin?: unknown;
  /** Top-level types and their kinds, when the app declares them. Others are worked out from content. */
  types?: Record<string, RootKind>;
}

/**
 * Makes `doc` look like `state` (a full document state, as a version stores it), in one
 * transaction. It writes ordinary changes, so they sync to everyone like any edit, and the
 * transaction can be undone. History is kept: nothing is rolled back, the old content is written again.
 */
export function restoreDocument(doc: Y.Doc, state: Uint8Array, options: RestoreOptions = {}): void {
  const source = new Y.Doc();
  Y.applyUpdate(source, state);
  const names = new Set([...doc.share.keys(), ...source.share.keys()]);
  doc.transact(() => {
    for (const name of names) {
      const current = doc.share.get(name);
      const previous = source.share.get(name);
      const kind =
        options.types?.[name] ??
        (current && rootKind(current)) ??
        (previous && rootKind(previous));
      if (!kind) continue; // empty on both sides
      const target = doc.get(name, CONSTRUCTORS[kind]);
      const from = source.get(name, CONSTRUCTORS[kind]);
      if (kind === "text") replaceText(target as Y.Text, from as Y.Text);
      else if (kind === "map") replaceMap(target as Y.Map<unknown>, from as Y.Map<unknown>);
      else replaceList(target as Y.Array<unknown> | Y.XmlFragment, from as Y.Array<unknown> | Y.XmlFragment);
    }
  }, options.origin);
  source.destroy();
}
