import { DOMParser } from "@xmldom/xmldom";
import {
  getNodeValue,
  Node as JSONCNode,
  parseTree,
  ParseError,
} from "jsonc-parser";
import { toJSONPath, toXPath } from "./paths";

export type DocumentKind = "xml" | "json";

export type NodeKind =
  | "xml-element"
  | "xml-attribute"
  | "xml-text"
  | "json-object"
  | "json-array"
  | "json-value";

export type ValueKind =
  | "element"
  | "attribute"
  | "text"
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null";

export interface OffsetRange {
  start: number;
  end: number;
}

export interface TreeNodeData {
  id: string;
  parentId: string | null;
  depth: number;
  label: string;
  description?: string;
  path: string;
  displayPath: string;
  kind: NodeKind;
  valueKind: ValueKind;
  preview: string;
  hasChildren: boolean;
  children: string[];
  range?: OffsetRange;
  selectionRange?: OffsetRange;
  domNode?: Node;
  jsonNode?: JSONCNode;
  value?: string | number | boolean | null;
}

export interface SerializedTreeNode {
  id: string;
  parentId: string | null;
  label: string;
  description?: string;
  path: string;
  displayPath: string;
  kind: NodeKind;
  valueKind: ValueKind;
  preview: string;
  hasChildren: boolean;
}

export interface NodeSpan {
  nodeId: string;
  start: number;
  end: number;
  depth: number;
}

export interface DocumentTree {
  documentType: DocumentKind;
  rootIds: string[];
  nodes: Map<string, TreeNodeData>;
  pathToNodeId: Map<string, string>;
  spans: NodeSpan[];
  xmlDocument?: Document;
  jsonRoot?: JSONCNode;
  namespaces?: Record<string, string>;
}

export interface BuildTreeOptions {
  compactPaths: boolean;
  outputLimit: number;
  includeWhitespaceText?: boolean;
}

export interface BuildTreeResult {
  tree?: DocumentTree;
  error?: string;
}

export function buildDocumentTree(
  text: string,
  documentType: DocumentKind,
  options: BuildTreeOptions,
): BuildTreeResult {
  if (documentType === "xml") {
    return buildXmlTree(text, options);
  }

  return buildJsonTree(text, options);
}

function toJSONDisplayPath(
  segments: (string | number)[],
  compactPaths: boolean,
): string {
  if (!segments.length) {
    return "$";
  }

  const parts: string[] = ["$"];

  for (const segment of segments) {
    if (typeof segment === "number") {
      parts.push("[*]");
    } else if (/^[A-Za-z_$][\w$]*$/.test(segment)) {
      parts.push(`.${segment}`);
    } else {
      const escaped = segment.replace(/'/g, "\\'");
      parts.push(`['${escaped}']`);
    }
  }

  return parts.join("").replace(/\.\[/g, "[");
}

export function getSerializedNodes(
  tree: DocumentTree,
  nodeIds: string[],
): SerializedTreeNode[] {
  const serialized: SerializedTreeNode[] = [];

  for (const id of nodeIds) {
    const node = tree.nodes.get(id);
    if (!node) {
      continue;
    }

    serialized.push({
      id: node.id,
      parentId: node.parentId,
      label: node.label,
      description: node.description,
      path: node.path,
      displayPath: node.displayPath,
      kind: node.kind,
      valueKind: node.valueKind,
      preview: node.preview,
      hasChildren: node.hasChildren,
    });
  }

  return serialized;
}

export function getChildNodeIds(tree: DocumentTree, nodeId?: string): string[] {
  if (!nodeId) {
    return tree.rootIds.slice();
  }

  const node = tree.nodes.get(nodeId);
  if (!node) {
    return [];
  }

  return node.children.slice();
}

export function findNodeAtOffset(
  tree: DocumentTree,
  offset: number,
): TreeNodeData | undefined {
  if (!tree.spans.length) {
    return undefined;
  }

  // Binary search to find first span that starts after the offset
  let low = 0;
  let high = tree.spans.length - 1;
  let firstGreaterIndex = tree.spans.length;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const span = tree.spans[mid];

    if (span.start > offset) {
      firstGreaterIndex = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  let best: TreeNodeData | undefined;
  let bestDepth = -1;
  let bestRangeSize = Number.POSITIVE_INFINITY;

  for (let i = firstGreaterIndex - 1; i >= 0; i--) {
    const span = tree.spans[i];
    if (span.end <= offset) {
      break;
    }

    if (span.start <= offset && offset < span.end) {
      const node = tree.nodes.get(span.nodeId);
      if (!node) {
        continue;
      }

      const range = node.range;
      const rangeSize = range
        ? range.end - range.start
        : Number.POSITIVE_INFINITY;

      if (
        span.depth > bestDepth ||
        (span.depth === bestDepth && rangeSize < bestRangeSize)
      ) {
        best = node;
        bestDepth = span.depth;
        bestRangeSize = rangeSize;
      }
    }
  }

  return best;
}

function buildXmlTree(
  text: string,
  options: BuildTreeOptions,
): BuildTreeResult {
  const parser = new DOMParser({
    locator: {},
    errorHandler: {
      warning: () => {},
      error: (msg: string | Error) => {
        throw new Error(typeof msg === "string" ? msg : msg.message);
      },
      fatalError: (msg: string | Error) => {
        throw new Error(typeof msg === "string" ? msg : msg.message);
      },
    },
  });

  let doc: Document;

  try {
    doc = parser.parseFromString(text, "text/xml");
  } catch (error: any) {
    return { error: `XML parsing error: ${error.message}` };
  }

  const parseErrors = doc.getElementsByTagName("parsererror");
  if (parseErrors.length > 0) {
    return {
      error: `XML parsing error: ${parseErrors[0].textContent ?? "Unknown error"}`,
    };
  }

  const documentElement = doc.documentElement;
  if (!documentElement) {
    return { error: "XML document is empty." };
  }

  const tree: DocumentTree = {
    documentType: "xml",
    rootIds: [],
    nodes: new Map(),
    pathToNodeId: new Map(),
    spans: [],
    xmlDocument: doc,
    namespaces: collectNamespaces(documentElement),
  };

  const lineOffsets = computeLineOffsets(text);

  const processElement = (
    element: Element,
    parentId: string | null,
    depth: number,
  ): string => {
    const path = toXPath(element, options.compactPaths);
    const id = path;

    const hasElementChildren = (() => {
      for (let i = 0; i < element.childNodes.length; i++) {
        if (element.childNodes[i].nodeType === 1) {
          return true;
        }
      }
      return false;
    })();

    const startOffset = positionToOffset(
      getLineNumber(element, 1),
      getColumnNumber(element, 1),
      lineOffsets,
    );
    const elementMarkup = element.toString();
    const endOffset = startOffset + elementMarkup.length;

    const elementText = (element.textContent ?? "").trim();
    const preview = hasElementChildren
      ? ""
      : truncate(elementText, options.outputLimit);

    const node: TreeNodeData = {
      id,
      parentId,
      depth,
      label: element.tagName,
      description: preview || undefined,
      path,
      displayPath: path,
      kind: "xml-element",
      valueKind: "element",
      preview,
      hasChildren: false,
      children: [],
      range: { start: startOffset, end: endOffset },
      selectionRange: {
        start: startOffset,
        end: startOffset + element.tagName.length + 1,
      },
      domNode: element,
      value: !hasElementChildren && elementText ? elementText : undefined,
    };

    tree.nodes.set(id, node);
    tree.pathToNodeId.set(path, id);
    tree.spans.push({ nodeId: id, start: startOffset, end: endOffset, depth });

    // Attributes first
    if (element.attributes) {
      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes.item(i);
        if (!attr) {
          continue;
        }

        const attrPath = toXPath(attr, options.compactPaths);
        const attrId = attrPath;
        const attrStart = positionToOffset(
          getLineNumber(attr, getLineNumber(element, 1)),
          getColumnNumber(attr, getColumnNumber(element, 1)),
          lineOffsets,
        );
        const attrMarkup = attr.toString();
        const attrEnd = attrStart + attrMarkup.length;

        const attrNode: TreeNodeData = {
          id: attrId,
          parentId: id,
          depth: depth + 1,
          label: `@${attr.name}`,
          description: truncate(attr.value, options.outputLimit),
          path: attrPath,
          displayPath: attrPath,
          kind: "xml-attribute",
          valueKind: "attribute",
          preview: truncate(attr.value, options.outputLimit),
          hasChildren: false,
          children: [],
          range: { start: attrStart, end: attrEnd },
          selectionRange: { start: attrStart, end: attrEnd },
          domNode: attr,
          value: attr.value,
        };

        tree.nodes.set(attrId, attrNode);
        tree.pathToNodeId.set(attrPath, attrId);
        tree.spans.push({
          nodeId: attrId,
          start: attrStart,
          end: attrEnd,
          depth: depth + 1,
        });
        node.children.push(attrId);
      }
    }

    // Child nodes (elements and text)
    for (let i = 0; i < element.childNodes.length; i++) {
      const child = element.childNodes[i];

      if (child.nodeType === 1) {
        const childId = processElement(child as Element, id, depth + 1);
        node.children.push(childId);
      } else if (child.nodeType === 3) {
        const textNode = child as Text;
        const raw = textNode.data ?? "";
        const trimmed = raw.trim();

        if (!trimmed && !options.includeWhitespaceText) {
          continue;
        }

        const textPath = toXPath(textNode, options.compactPaths);
        const textId = textPath;
        const textStart = positionToOffset(
          getLineNumber(textNode, getLineNumber(element, 1)),
          getColumnNumber(textNode, getColumnNumber(element, 1)),
          lineOffsets,
        );
        const textEnd = textStart + raw.length;
        const previewText = truncate(trimmed || raw, options.outputLimit);

        const textNodeData: TreeNodeData = {
          id: textId,
          parentId: id,
          depth: depth + 1,
          label: "text()",
          description: previewText,
          path: textPath,
          displayPath: textPath,
          kind: "xml-text",
          valueKind: "text",
          preview: previewText,
          hasChildren: false,
          children: [],
          range: { start: textStart, end: textEnd },
          selectionRange: { start: textStart, end: textEnd },
          domNode: textNode,
          value: trimmed || raw,
        };

        tree.nodes.set(textId, textNodeData);
        tree.pathToNodeId.set(textPath, textId);
        tree.spans.push({
          nodeId: textId,
          start: textStart,
          end: textEnd,
          depth: depth + 1,
        });
        node.children.push(textId);
      }
    }

    node.hasChildren = node.children.length > 0;

    return id;
  };

  const rootId = processElement(documentElement, null, 0);
  tree.rootIds.push(rootId);

  tree.spans.sort((a, b) => a.start - b.start || b.depth - a.depth);

  return { tree };
}

function buildJsonTree(
  text: string,
  options: BuildTreeOptions,
): BuildTreeResult {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (!root) {
    const error = errors[0];
    if (error) {
      return {
        error: `JSON parsing error at offset ${error.offset}: ${error.error}`,
      };
    }
    return { error: "JSON parsing error: Failed to parse document." };
  }

  const tree: DocumentTree = {
    documentType: "json",
    rootIds: [],
    nodes: new Map(),
    pathToNodeId: new Map(),
    spans: [],
    jsonRoot: root,
  };

  const createNode = (
    node: JSONCNode,
    parentId: string | null,
    label: string,
    pathSegments: (string | number)[],
    depth: number,
  ): string => {
    const path = toJSONPath(pathSegments, options.compactPaths);
    const id = path;
    const start = node.offset;
    const end = node.offset + node.length;

    const propertyNode =
      node.parent && node.parent.type === "property" ? node.parent : undefined;
    const spanStart = propertyNode ? propertyNode.offset : start;
    const spanEnd = propertyNode
      ? propertyNode.offset + propertyNode.length
      : end;

    const displayPath = toJSONDisplayPath(pathSegments, options.compactPaths);

    const { kind, valueKind, preview, description, value } = describeJsonNode(
      node,
      options.outputLimit,
    );

    const treeNode: TreeNodeData = {
      id,
      parentId,
      depth,
      label,
      description,
      path,
      displayPath,
      kind,
      valueKind,
      preview,
      hasChildren: false,
      children: [],
      range: { start, end },
      selectionRange: { start: spanStart, end: spanEnd },
      jsonNode: node,
      value,
    };

    tree.nodes.set(id, treeNode);
    tree.pathToNodeId.set(path, id);
    tree.spans.push({ nodeId: id, start: spanStart, end: spanEnd, depth });

    if (node.type === "object" && node.children) {
      for (const propertyNode of node.children) {
        if (!propertyNode.children || propertyNode.children.length < 2) {
          continue;
        }

        const keyNode = propertyNode.children[0];
        const valueNode = propertyNode.children[1];
        const key = keyNode.value as string;
        const childSegments = [...pathSegments, key];
        const childId = createNode(
          valueNode,
          id,
          key,
          childSegments,
          depth + 1,
        );
        treeNode.children.push(childId);
      }
    } else if (node.type === "array" && node.children) {
      for (let i = 0; i < node.children.length; i++) {
        const valueNode = node.children[i];
        const childSegments = [...pathSegments, i];
        const childId = createNode(
          valueNode,
          id,
          `[${i}]`,
          childSegments,
          depth + 1,
        );
        treeNode.children.push(childId);
      }
    }

    treeNode.hasChildren = treeNode.children.length > 0;

    return id;
  };

  const rootId = createNode(root, null, "Root", [], 0);
  tree.rootIds.push(rootId);
  tree.spans.sort((a, b) => a.start - b.start || b.depth - a.depth);

  return { tree };
}

function describeJsonNode(
  node: JSONCNode,
  limit: number,
): {
  kind: NodeKind;
  valueKind: ValueKind;
  preview: string;
  description?: string;
  value?: string | number | boolean | null;
} {
  const value = getNodeValue(node);

  switch (node.type) {
    case "object": {
      const childCount = node.children ? node.children.length : 0;
      return {
        kind: "json-object",
        valueKind: "object",
        preview: `Object (${childCount} ${childCount === 1 ? "entry" : "entries"})`,
        description: `Object (${childCount} ${childCount === 1 ? "entry" : "entries"})`,
      };
    }
    case "array": {
      const childCount = node.children ? node.children.length : 0;
      return {
        kind: "json-array",
        valueKind: "array",
        preview: `Array (${childCount} ${childCount === 1 ? "item" : "items"})`,
        description: `Array (${childCount} ${childCount === 1 ? "item" : "items"})`,
      };
    }
    case "string": {
      const stringValue = typeof value === "string" ? value : "";
      const quoted = `"${truncate(stringValue, limit)}"`;
      return {
        kind: "json-value",
        valueKind: "string",
        preview: quoted,
        description: quoted,
        value: stringValue,
      };
    }
    case "number": {
      const numberValue = typeof value === "number" ? value : Number(value);
      const text = String(numberValue);
      return {
        kind: "json-value",
        valueKind: "number",
        preview: text,
        description: text,
        value: numberValue,
      };
    }
    case "boolean": {
      const boolValue = Boolean(value);
      const text = boolValue ? "true" : "false";
      return {
        kind: "json-value",
        valueKind: "boolean",
        preview: text,
        description: text,
        value: boolValue,
      };
    }
    case "null": {
      return {
        kind: "json-value",
        valueKind: "null",
        preview: "null",
        description: "null",
        value: null,
      };
    }
    default: {
      return {
        kind: "json-value",
        valueKind: "string",
        preview: truncate(String(value ?? ""), limit),
        description: truncate(String(value ?? ""), limit),
        value: typeof value === "string" ? value : null,
      };
    }
  }
}

function getLineNumber(node: any, fallback: number): number {
  const value = node?.lineNumber;
  return typeof value === "number" ? value : fallback;
}

function getColumnNumber(node: any, fallback: number): number {
  const value = node?.columnNumber;
  return typeof value === "number" ? value : fallback;
}

function computeLineOffsets(text: string): number[] {
  const offsets: number[] = [0];

  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      offsets.push(i + 1);
    }
  }

  return offsets;
}

function positionToOffset(
  line: number,
  column: number,
  lineOffsets: number[],
): number {
  const lineIndex = Math.max(0, Math.min(lineOffsets.length - 1, line - 1));
  return lineOffsets[lineIndex] + Math.max(0, column - 1);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return value.substring(0, limit) + "…";
}

function collectNamespaces(element: Element): Record<string, string> {
  const namespaces: Record<string, string> = {};

  const visit = (node: Element) => {
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i++) {
        const attr = node.attributes.item(i);
        if (!attr) {
          continue;
        }

        if (attr.name === "xmlns") {
          namespaces[""] = attr.value;
        } else if (attr.name.startsWith("xmlns:")) {
          const prefix = attr.name.substring("xmlns:".length);
          if (prefix && !namespaces[prefix]) {
            namespaces[prefix] = attr.value;
          }
        }
      }
    }

    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child.nodeType === 1) {
        visit(child as Element);
      }
    }
  };

  visit(element);
  return namespaces;
}
