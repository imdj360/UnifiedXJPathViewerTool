# UnifiedXJPath (Dansharp) Viewer

**UnifiedXJPath (Dansharp) Viewer** is a Visual Studio Code extension that turns your XML and JSON files into a live, split-view query workbench. The left pane shows a filterable, lazily-loaded tree of the active document, while the right pane lets you inspect nodes, evaluate XPath or JSONPath expressions, and jump straight back into the editor.

## Highlights

- **Single Webview UI** – Tree on the left, Inspector on the right, Query input on top.
- **Automatic Detection** – Chooses XPath for XML files and JSONPath for JSON/JSONC files.
- **Live Tree & Inspector** – Expand nodes on demand, filter them quickly, and inspect the currently selected node’s absolute path, value preview, and type.
- **Two-way Synchronisation** – Selecting nodes in the tree reveals them in the editor; moving the caret in the editor selects and scrolls the matching tree node.
- **Inline Query Runner** – Evaluate expressions without leaving the viewer. Results include previews, absolute paths, and reveal-on-click support.
- **Copy Helpers** – One-click actions for copying absolute paths and node values or revealing nodes back in the editor.
- **Auto Refresh** – Changes in the document trigger a debounced rebuild of the tree and inspector.
- **XPath Flexibility** – Enter simple absolute paths with or without `[1]` predicates; the viewer fills in singleton indexes automatically.

## Getting Started

1. Open any XML or JSON/JSONC document in VS Code.
2. Run **`UnifiedXJPath Viewer: Open Query Viewer`** from the Command Palette.
3. The viewer opens beside your editor, initialising with the current document.

### Evaluating Queries

1. Type an XPath (for XML) or JSONPath (for JSON) expression into the query input.
2. Press **Enter** or click **Evaluate**.
3. The inspector shows the match count and lists each result with its preview, path, and a _Reveal_ button that jumps to the location in the editor.
4. The output limit for previews defaults to 200 characters and can be customised (see Settings).

- For XML, you can omit positional predicates on straightforward absolute paths (e.g. `/ns0:ShipmentConfirmation/ns0:Orders/ns0:OrderItems/ns0:Sequence`); the viewer matches all siblings automatically. Add `[1]`, `[2]`, etc. only when you want a specific occurrence.

### Navigating the Tree

- Expand nodes as needed; children are loaded on demand for performance.
- Use the filter box above the tree to quickly locate nodes by label or path.
- Clicking a node selects it and updates the inspector; double-clicking toggles expansion (or reveals if it is a leaf).
- Editor caret moves automatically focus and scroll the tree to the nearest node.

### Inspector Actions

- **Path** – Absolute XPath (with 1-based indexes) or JSONPath for the selected node.
- **Value Preview** – Trimmed preview or pretty-printed snippet for complex content.
- **Copy Path / Copy Value** – Buttons send the respective content to the clipboard.
- **Reveal in Editor** – Re-selects the underlying text range in the editor.

### Query Results

- The results panel lists matches in order; each entry shows the path, value preview, and type.
- Click **Reveal** on any result to highlight it in the editor and tree.
- The VS Code status bar displays the latest match count.

## Commands

| Command                                                                      | Description                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `UnifiedXJPath Viewer: Open Query Viewer` (`unifiedxjpath.openViewer`)       | Opens or focuses the split viewer beside the editor.                                       |
| `UnifiedXJPath Viewer: Evaluate Query` (`unifiedxjpath.evaluateQuery`)       | Prompts for an expression and pushes the results into the viewer.                          |
| `UnifiedXJPath Viewer: Copy Path` (`unifiedxjpath.copyPath`)                 | Copies the absolute path for the node under the current editor caret.                      |
| `UnifiedXJPath Viewer: Format Document` (`unifiedxjpath.formatDocument`)     | Formats the active XML/JSON document (or the current selection) using VS Code's formatter. |
| `UnifiedXJPath Viewer: Manage Namespaces` (`unifiedxjpath.manageNamespaces`) | Interactive UI for adding, removing, or clearing XPath namespace prefixes.                 |

## Settings

All configuration settings live under the `unifiedQuery` namespace:

| Setting                     | Type      | Default | Description                                                                                  |
| --------------------------- | --------- | ------- | -------------------------------------------------------------------------------------------- |
| `unifiedQuery.namespaces`   | `object`  | `{}`    | Namespace prefix → URI mappings used when evaluating XPath expressions.                      |
| `unifiedQuery.outputLimit`  | `number`  | `200`   | Maximum number of characters shown in tree previews, inspector values, and query results.    |
| `unifiedQuery.compactPaths` | `boolean` | `false` | When enabled, omits redundant `[1]` predicates from generated XPaths for singleton siblings. |

## Notes

- JSON documents are parsed with the `jsonc-parser`, so JSON with comments or trailing commas is supported.
- XPath evaluation uses `@xmldom/xmldom` and `xpath` (XPath 1.0). JSONPath evaluation relies on `jsonpath-plus`.
- Large documents remain responsive thanks to debounced refreshes and lazy node loading in the tree.
- Query errors, parse issues, and other problems are reported directly inside the viewer and through VS Code notifications.

Enjoy querying! If you have ideas to make the viewer more powerful or easier to use, contributions and suggestions are always welcome.

---

### Acknowledgements

Thanks to **PronertDaniel** and the original [Dansharp XML Viewer](https://github.com/probertdaniel/dansharpxmlviewer.git) for the inspiration that helped shape the XPath workflow in this extension. His work has helped BizTalk and integration developers over the years—this project proudly builds on that effort and keeps the Dansharp spirit alive by contributing back through the UnifiedXJPath (Dansharp) Viewer.
