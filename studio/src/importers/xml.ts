/**
 * Minimal ElementTree-shaped XML tree over saxes (ISC), namespace-resolving and
 * usable in Node, Electron and browsers. GPX files are parsed here instead of
 * with DOMParser so importer behaviour stays identical across runtimes.
 */
import { SaxesParser } from 'saxes';

const XMLNS_URI = 'http://www.w3.org/2000/xmlns/';

export interface XmlNode {
  /** Resolved tag: `{uri}local`, or `local` when the element has no namespace. */
  tag: string;
  /** Resolved attribute name → value; `xmlns` declarations are omitted, like ElementTree. */
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct leading text before the first child. */
  text: string;
  /** Direct text after the element within its parent (not used by findtext). */
  tail: string;
}

function resolveTag(local: string, uri: string): string {
  return uri ? `{${uri}}${local}` : local;
}

/** Parse a whole XML document into an ElementTree-like tree (synchronous). */
export function parseXml(text: string): XmlNode {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let pending = '';
  let selfClosing = false;
  let error: Error | null = null;

  parser.on('error', (e) => {
    error = e;
  });
  parser.on('text', (t) => {
    pending += t;
  });
  parser.on('cdata', (t) => {
    pending += t;
  });
  parser.on('opentag', (n) => {
    const parent = stack.length ? stack[stack.length - 1] : null;
    if (parent) {
      if (parent.children.length === 0) parent.text = pending;
      else parent.children[parent.children.length - 1].tail = pending;
    }
    pending = '';
    const attrs: Record<string, string> = {};
    for (const attr of Object.values(n.attributes)) {
      if (attr.uri === XMLNS_URI) continue;
      attrs[resolveTag(attr.local, attr.uri)] = attr.value;
    }
    const node: XmlNode = { tag: resolveTag(n.local, n.uri), attrs, children: [], text: '', tail: '' };
    if (parent) parent.children.push(node);
    else if (root === null) root = node;
    if (n.isSelfClosing) selfClosing = true;
    else stack.push(node);
  });
  parser.on('closetag', () => {
    if (selfClosing) {
      selfClosing = false;
      return;
    }
    const node = stack.pop();
    if (!node) return;
    if (node.children.length === 0) node.text = pending;
    else node.children[node.children.length - 1].tail = pending;
    pending = '';
  });

  parser.write(text);
  parser.close();

  if (error) throw error;
  if (root === null) throw new Error('No root element found');
  return root;
}

/** Direct children with the given resolved tag, in document order. */
export function findall(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((c) => c.tag === tag);
}

/** First direct child with the given resolved tag, or null. */
export function find(node: XmlNode, tag: string): XmlNode | null {
  return node.children.find((c) => c.tag === tag) ?? null;
}

/** `find` then `.text`, matching ElementTree's `findtext` (empty text is null). */
export function findtext(node: XmlNode, tag: string): string | null {
  const child = find(node, tag);
  return child ? child.text || null : null;
}

/** Pre-order iteration of `node` and all descendants, optionally filtered by tag. */
export function* iter(node: XmlNode, tag?: string): Generator<XmlNode> {
  if (!tag || node.tag === tag) yield node;
  for (const child of node.children) yield* iter(child, tag);
}

export function namespaceOf(node: XmlNode): string {
  return node.tag.startsWith('{') ? node.tag.slice(1).split('}')[0] : '';
}