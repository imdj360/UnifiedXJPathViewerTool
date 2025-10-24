import { DOMParser } from "@xmldom/xmldom";
import { JSONPath } from "jsonpath-plus";
import * as xpath from "xpath";
import type { DocumentTree, TreeNodeData } from "./tree";
import { normalizeJSONPath, parseJSONPath, toJSONPath, toXPath } from "./paths";

export interface QueryResult {
  type: "node" | "string" | "number" | "boolean" | "object" | "array";
  value: any;
  preview: string;
  path?: string;
  range?: { start: number; end: number };
}

export interface XPathQueryOptions {
  namespaces?: Record<string, string>;
  compactPaths?: boolean;
  outputLimit?: number;
  tree?: DocumentTree;
  document?: Document;
}

export interface JSONPathQueryOptions {
  compactPaths?: boolean;
  outputLimit?: number;
  tree?: DocumentTree;
}

const DEFAULT_OUTPUT_LIMIT = 200;

export function evaluateXPath(
  text: string,
  expression: string,
  options: XPathQueryOptions = {},
): { results: QueryResult[]; error?: string } {
  const compactPaths = options.compactPaths ?? false;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  let document: Document | undefined =
    options.document ?? options.tree?.xmlDocument;

  if (!document) {
    try {
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

      document = parser.parseFromString(text, "text/xml");

      const parseErrors = document.getElementsByTagName("parsererror");
      if (parseErrors.length > 0) {
        return {
          results: [],
          error: `XML parsing error: ${parseErrors[0].textContent ?? "Unknown error"}`,
        };
      }
    } catch (error: any) {
      return { results: [], error: `XML parsing error: ${error.message}` };
    }
  }

  try {
    const namespaces = options.namespaces ?? {};
    const select =
      Object.keys(namespaces).length > 0
        ? xpath.useNamespaces(namespaces)
        : xpath.select;
    const rawResult = select(expression, document as any);

    const resultsArray = Array.isArray(rawResult) ? rawResult : [rawResult];
    const results: QueryResult[] = [];

    for (const item of resultsArray) {
      const formatted = formatXPathResult(item, {
        compactPaths,
        outputLimit,
        tree: options.tree,
      });
      if (formatted) {
        results.push(formatted);
      }
    }

    return { results };
  } catch (error: any) {
    return { results: [], error: `XPath evaluation error: ${error.message}` };
  }
}

export function evaluateJSONPath(
  text: string,
  expression: string,
  options: JSONPathQueryOptions = {},
): { results: QueryResult[]; error?: string } {
  const compactPaths = options.compactPaths ?? false;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;

  let json: any;
  try {
    json = JSON.parse(text);
  } catch (error: any) {
    return { results: [], error: `JSON parsing error: ${error.message}` };
  }

  try {
    const rewrittenExpression = expandImplicitArrayWildcards(
      expression,
      options.tree,
      compactPaths,
    );

    const rawResults = JSONPath({
      path: rewrittenExpression ?? expression,
      json,
      resultType: "all",
    });

    const results: QueryResult[] = [];

    for (const item of rawResults) {
      const pathString = typeof item.path === "string" ? item.path : "";
      let canonicalPath: string | undefined;

      try {
        const segments = parseJSONPath(pathString);
        canonicalPath = toJSONPath(segments, compactPaths);
      } catch {
        canonicalPath = pathString
          ? normalizeJSONPath(pathString, compactPaths)
          : undefined;
      }

      const result: QueryResult = {
        type: determineJsonValueType(item.value),
        value: item.value,
        preview: formatJsonPreview(item.value, outputLimit),
        path: canonicalPath ?? pathString,
      };

      if (canonicalPath && options.tree) {
        const treeNode = lookupTreeNode(options.tree, canonicalPath);
        if (treeNode?.range) {
          result.range = { ...treeNode.range };
        }
      }

      results.push(result);
    }

    return { results };
  } catch (error: any) {
    return {
      results: [],
      error: `JSONPath evaluation error: ${error.message}`,
    };
  }
}

function expandImplicitArrayWildcards(
  expression: string,
  tree: DocumentTree | undefined,
  compactPaths: boolean,
): string | undefined {
  if (!tree) {
    return undefined;
  }

  try {
    const segments = parseJSONPath(expression);
    if (!segments.length) {
      return expression;
    }

    const lookupSegments: (string | number)[] = [];
    const parts: string[] = ["$"];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];

      if (typeof segment === "number") {
        parts.push(`[${segment}]`);
        lookupSegments.push(segment);
      } else if (/^[A-Za-z_$][\w$]*$/.test(segment)) {
        parts.push(`.${segment}`);
        lookupSegments.push(segment);
      } else {
        const escaped = segment.replace(/'/g, "\\'");
        parts.push(`['${escaped}']`);
        lookupSegments.push(segment);
      }

      const currentPath = toJSONPath(lookupSegments, compactPaths);
      const nodeId = tree.pathToNodeId.get(currentPath);
      const node = nodeId ? tree.nodes.get(nodeId) : undefined;
      if (!node) {
        continue;
      }

      const nextSegment = segments[i + 1];
      if (node.valueKind === "array" && typeof nextSegment === "string") {
        parts.push("[*]");
        lookupSegments.push(0);
      }
    }

    const rewritten = parts.join("").replace(/\.\[/g, "[");
    return rewritten === expression ? undefined : rewritten;
  } catch (error) {
    return undefined;
  }
}

function formatXPathResult(
  value: any,
  options: { compactPaths: boolean; outputLimit: number; tree?: DocumentTree },
): QueryResult | null {
  if (typeof value === "string") {
    return {
      type: "string",
      value,
      preview: truncate(value, options.outputLimit),
    };
  }

  if (typeof value === "number") {
    return {
      type: "number",
      value,
      preview: value.toString(),
    };
  }

  if (typeof value === "boolean") {
    return {
      type: "boolean",
      value,
      preview: value ? "true" : "false",
    };
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const node = value as Node;
  const path = toXPath(node, options.compactPaths);
  const preview = formatXmlPreview(node, options.outputLimit);
  const result: QueryResult = {
    type: "node",
    value: node,
    preview,
    path,
  };

  if (options.tree) {
    const treeNode = lookupTreeNode(options.tree, path);
    if (treeNode?.range) {
      result.range = { ...treeNode.range };
    }
  }

  return result;
}

function formatXmlPreview(node: Node, limit: number): string {
  if (node.nodeType === 1) {
    const element = node as Element;
    const text = (element.textContent ?? "").trim();
    if (text) {
      return truncate(text, limit);
    }
    const attrs: string[] = [];
    if (element.attributes) {
      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes.item(i) as Attr | null;
        if (!attr) {
          continue;
        }
        attrs.push(`${attr.name}="${attr.value}"`);
      }
    }
    return attrs.length
      ? `<${element.tagName} ${attrs.join(" ")}>`
      : `<${element.tagName}>`;
  }

  if (node.nodeType === 2) {
    const attr = node as Attr;
    return `@${attr.name}="${truncate(attr.value, limit)}"`;
  }

  if (node.nodeType === 3) {
    const text = (node as Text).data ?? "";
    return truncate(text.trim() || text, limit);
  }

  return truncate(node.toString(), limit);
}

function formatJsonPreview(value: any, limit: number): string {
  if (Array.isArray(value)) {
    const header = `Array(${value.length})`;
    if (!value.length) {
      return header;
    }
    return `${header} ${truncate(JSON.stringify(value, null, 2), limit)}`;
  }

  switch (typeof value) {
    case "object":
      if (value === null) {
        return "null";
      }
      {
        const keys = Object.keys(value);
        const header = `Object(${keys.length})`;
        if (!keys.length) {
          return header;
        }
        return `${header} ${truncate(JSON.stringify(value, null, 2), limit)}`;
      }
    case "string":
      return `"${truncate(value, limit)}"`;
    case "number":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    default:
      return truncate(String(value), limit);
  }
}

function determineJsonValueType(value: any): QueryResult["type"] {
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "object":
      return value === null ? "string" : "object";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

function lookupTreeNode(
  tree: DocumentTree,
  path: string,
): TreeNodeData | undefined {
  const nodeId = tree.pathToNodeId.get(path);
  if (!nodeId) {
    return undefined;
  }
  return tree.nodes.get(nodeId);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return value.substring(0, limit) + "…";
}
