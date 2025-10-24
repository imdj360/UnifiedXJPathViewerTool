/**
 * Generates an absolute XPath expression for an XML node.
 * Uses 1-based positional predicates unless compactPaths hides singleton predicates.
 */
export function toXPath(node: Node, compactPaths: boolean = false): string {
  const segments: string[] = [];
  let current: Node | null = node;

  while (current && current.nodeType !== 9 /* DOCUMENT_NODE */) {
    if (current.nodeType === 1 /* ELEMENT_NODE */) {
      const element = current as Element;
      const tagName = element.tagName;
      const parent = element.parentNode;

      let position = 1;
      let sameNameCount = 0;

      if (parent) {
        for (let i = 0; i < parent.childNodes.length; i++) {
          const sibling = parent.childNodes[i];
          if (
            sibling.nodeType === 1 &&
            (sibling as Element).tagName === tagName
          ) {
            sameNameCount++;
            if (sibling === element) {
              position = sameNameCount;
            }
          }
        }
      } else {
        sameNameCount = 1;
      }

      if (compactPaths && sameNameCount === 1) {
        segments.unshift(tagName);
      } else {
        segments.unshift(`${tagName}[${position}]`);
      }

      current = parent;
    } else if (current.nodeType === 2 /* ATTRIBUTE_NODE */) {
      const attr = current as Attr;
      segments.unshift(`@${attr.name}`);
      current = attr.ownerElement;
    } else if (current.nodeType === 3 /* TEXT_NODE */) {
      const textNode = current as Text;
      const parent = textNode.parentNode;
      let position = 1;
      let totalTextNodes = 0;

      if (parent) {
        for (let i = 0; i < parent.childNodes.length; i++) {
          const sibling = parent.childNodes[i];
          if (sibling.nodeType === 3) {
            totalTextNodes++;
            if (sibling === textNode) {
              position = totalTextNodes;
            }
          }
        }
      }

      if (totalTextNodes > 1) {
        segments.unshift(`text()[${position}]`);
      } else {
        segments.unshift("text()");
      }

      current = parent;
    } else {
      current = current.parentNode;
    }
  }

  return "/" + segments.join("/");
}

/**
 * Generates an absolute JSONPath string from path segments.
 * Uses dot notation for identifier-friendly keys and bracket notation otherwise.
 */
export function toJSONPath(
  segments: (string | number)[],
  compactPaths: boolean = false,
): string {
  if (!segments.length) {
    return "$";
  }

  const parts: string[] = ["$"];

  for (const segment of segments) {
    if (typeof segment === "number") {
      parts.push(`[${segment}]`);
    } else if (/^[A-Za-z_$][\w$]*$/.test(segment)) {
      parts.push(`.${segment}`);
    } else {
      const escaped = segment.replace(/'/g, "\\'");
      parts.push(`['${escaped}']`);
    }
  }

  // Remove accidental ".[" sequences produced when a bracket segment follows dot notation.
  return parts.join("").replace(/\.\[/g, "[");
}

/**
 * Parses a JSONPath expression into an array of path segments.
 * Supports both dot notation and bracket notation with single quotes.
 */
export function parseJSONPath(path: string): (string | number)[] {
  if (!path || path === "$") {
    return [];
  }

  if (path.startsWith("$")) {
    path = path.substring(1);
  }

  const segments: (string | number)[] = [];
  let index = 0;

  while (index < path.length) {
    const char = path[index];

    if (char === ".") {
      index++;
      const match = /^[A-Za-z_$][\w$]*/.exec(path.substring(index));
      if (!match) {
        throw new Error(`Invalid JSONPath segment at position ${index}`);
      }
      segments.push(match[0]);
      index += match[0].length;
    } else if (char === "[") {
      index++;
      if (path[index] === "'" || path[index] === '"') {
        const quote = path[index];
        index++;
        let value = "";

        while (index < path.length) {
          const current = path[index];
          if (current === "\\") {
            const next = path[index + 1];
            if (next === quote || next === "\\") {
              value += next;
              index += 2;
            } else {
              value += next;
              index += 2;
            }
          } else if (current === quote) {
            index++;
            if (path[index] !== "]") {
              throw new Error(
                `Expected ] after quoted segment at position ${index}`,
              );
            }
            index++;
            segments.push(value);
            break;
          } else {
            value += current;
            index++;
          }
        }
      } else {
        const match = /^\d+/.exec(path.substring(index));
        if (!match) {
          throw new Error(`Expected numeric index at position ${index}`);
        }
        segments.push(parseInt(match[0], 10));
        index += match[0].length;
        if (path[index] !== "]") {
          throw new Error(`Expected ] after array index at position ${index}`);
        }
        index++;
      }
    } else {
      throw new Error(
        `Unexpected character "${char}" in JSONPath at position ${index}`,
      );
    }
  }

  return segments;
}

/**
 * Normalises any JSONPath string into the canonical representation
 * produced by {@link toJSONPath}.
 */
export function normalizeJSONPath(
  path: string,
  compactPaths: boolean = false,
): string {
  return toJSONPath(parseJSONPath(path), compactPaths);
}

const SIMPLE_NAME = "[A-Za-z_][\\w.-]*";
const SIMPLE_NAME_WITH_PREFIX = `${SIMPLE_NAME}(?::${SIMPLE_NAME})?`;
const ELEMENT_STEP_REGEX = new RegExp(
  `^${SIMPLE_NAME_WITH_PREFIX}(?:\\[\\d+\\])?$`,
);
const ATTRIBUTE_STEP_REGEX = new RegExp(`^@${SIMPLE_NAME_WITH_PREFIX}$`);
const TEXT_STEP_REGEX = new RegExp(`^text\\(\\)(?:\\[\\d+\\])?$`);

/**
 * Ensures that simple absolute XPath expressions include explicit singleton indexes.
 * Adds `[1]` to element steps that omit a predicate, leaving attributes and unsupported
 * patterns unchanged so complex expressions pass through untouched.
 */
export function ensureDefaultXPathIndexes(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return expression;
  }

  const segments = trimmed.split("/");
  let changed = false;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (segment === "") {
      continue;
    }

    if (ATTRIBUTE_STEP_REGEX.test(segment) || TEXT_STEP_REGEX.test(segment)) {
      continue;
    }

    if (!ELEMENT_STEP_REGEX.test(segment)) {
      return expression;
    }

    if (!segment.includes("[")) {
      segments[i] = `${segment}[1]`;
      changed = true;
    }
  }

  return changed ? segments.join("/") : expression;
}
