import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  buildDocumentTree,
  DocumentKind,
  DocumentTree,
  findNodeAtOffset,
  getChildNodeIds,
  getSerializedNodes,
  OffsetRange,
  TreeNodeData,
} from "./tree";
import { evaluateJSONPath, evaluateXPath, QueryResult } from "./queryEngine";

interface ViewerConfig {
  namespaces: Record<string, string>;
  compactPaths: boolean;
  outputLimit: number;
}

interface InspectorPayload {
  id: string;
  label: string;
  path: string;
  displayPath?: string;
  kind: string;
  valueKind: string;
  preview: string;
  valueText: string;
  range?: SerializedRange;
  selectionRange?: SerializedRange;
}

interface SerializedRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export function activate(context: vscode.ExtensionContext) {
  const manager = new QueryViewerManager(context);
  context.subscriptions.push(manager);
}

export function deactivate() {
  // Nothing to do – manager disposes via context subscriptions.
}

class QueryViewerManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private tree: DocumentTree | undefined;
  private treeVersion = 0;
  private activeDocument: vscode.TextDocument | undefined;
  private disposables: vscode.Disposable[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private selectionGuard = 0;
  private statusBarItem: vscode.StatusBarItem;
  private lastSelectionNodeId: string | undefined;
  private readonly mediaRoot: vscode.Uri;
  private readonly namespaceState: Map<string, Record<string, string>>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    context.subscriptions.push(this.statusBarItem);

    const storedNamespaces =
      context.workspaceState.get<Record<string, Record<string, string>>>(
        "unifiedQuery.namespacesState",
        {},
      ) ?? {};
    this.namespaceState = new Map(Object.entries(storedNamespaces));

    this.registerCommand("unifiedxjpath.openViewer", () => this.openViewer());
    this.registerCommand("unifiedxjpath.evaluateQuery", () =>
      this.evaluateQueryCommand(),
    );
    this.registerCommand("unifiedxjpath.copyPath", () =>
      this.copyCurrentPath(),
    );
    this.registerCommand("unifiedxjpath.formatDocument", () =>
      this.formatActiveDocument(),
    );
    this.registerCommand("unifiedxjpath.manageNamespaces", () =>
      this.manageNamespaces(),
    );

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.handleActiveEditorChange(editor),
      ),
      vscode.window.onDidChangeTextEditorSelection((event) =>
        this.handleSelectionChange(event),
      ),
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.handleDocumentChange(event),
      ),
      vscode.workspace.onDidCloseTextDocument((document) =>
        this.handleDocumentClosed(document),
      ),
    );

    const initialEditor = vscode.window.activeTextEditor;
    if (initialEditor && this.isSupportedDocument(initialEditor.document)) {
      this.activeDocument = initialEditor.document;
      void this.rebuildTree(initialEditor.document);
    }
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.statusBarItem.dispose();

    this.panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private registerCommand(command: string, callback: (...args: any[]) => any) {
    const disposable = vscode.commands.registerCommand(
      command,
      (...args: any[]) => {
        try {
          const result = callback(...args);
          return result;
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `UnifiedXJPath (Dansharp) Viewer command failed: ${error.message ?? error}`,
          );
          throw error;
        }
      },
    );
    this.context.subscriptions.push(disposable);
    this.disposables.push(disposable);
  }

  private async openViewer() {
    const editor = this.getRelevantEditor();
    if (!editor) {
      vscode.window.showErrorMessage(
        "Open an XML or JSON document to use the UnifiedXJPath (Dansharp) Viewer.",
      );
      return;
    }

    this.activeDocument = editor.document;
    await this.rebuildTree(editor.document);

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.sendInitialState();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "unifiedxjpathViewer",
      "UnifiedXJPath (Dansharp) Viewer",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.mediaRoot],
      },
    );

    this.panel.webview.html = this.getWebviewHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((message) =>
      this.handleWebviewMessage(message),
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.statusBarItem.hide();
    });
  }

  private handleWebviewMessage(message: any) {
    switch (message?.type) {
      case "ready":
        this.sendInitialState();
        break;
      case "requestChildren":
        this.sendChildren(message.nodeId);
        break;
      case "selectNode":
        this.handleWebviewSelection(message.nodeId, Boolean(message.reveal));
        break;
      case "copyPath":
        this.copyPathById(message.nodeId ?? message.path);
        break;
      case "copyValue":
        this.copyValueById(message.nodeId);
        break;
      case "revealNode":
        this.revealNodeInEditor(message.nodeId);
        break;
      case "evaluateQuery":
        void this.evaluateQuery(message.query);
        break;
      case "focusEditor":
        this.revealNodeInEditor(message.nodeId, { preserveFocus: false });
        break;
      default:
        break;
    }
  }

  private async evaluateQueryCommand() {
    const editor = this.getRelevantEditor();
    const document = editor?.document ?? this.activeDocument;
    if (!document || !this.isSupportedDocument(document)) {
      vscode.window.showErrorMessage(
        "Open an XML or JSON document before running a query.",
      );
      return;
    }

    const docType = this.getDocumentKind(document);
    if (!docType) {
      vscode.window.showErrorMessage(
        "Unsupported document type. Only XML and JSON are supported.",
      );
      return;
    }

    const queryLabel = docType === "xml" ? "XPath" : "JSONPath";
    const query = await vscode.window.showInputBox({
      prompt: `Enter ${queryLabel} expression`,
      placeHolder: docType === "xml" ? "/root/item[1]" : "$.root.items[0]",
      validateInput: (value) =>
        value.trim() ? undefined : "Query cannot be empty.",
    });

    if (!query) {
      return;
    }

    await this.openViewer();
    await this.evaluateQuery(query);
  }

  private async evaluateQuery(query: string) {
    const editor = this.getRelevantEditor();
    const document = editor?.document ?? this.activeDocument;
    if (!document || !this.isSupportedDocument(document)) {
      const message = "Open an XML or JSON document to evaluate queries.";
      vscode.window.showErrorMessage(message);
      this.sendQueryStatus({ error: message });
      return;
    }

    this.activeDocument = document;
    const docType = this.getDocumentKind(document);
    if (!docType) {
      const message = "Unsupported document type.";
      vscode.window.showErrorMessage(message);
      this.sendQueryStatus({ error: message });
      return;
    }

    await this.rebuildTree(document);

    const config = this.getViewerConfig();
    const namespaces = this.getNamespacesForDocument(document);
    const autoNamespaces = this.tree?.namespaces ?? {};
    const effectiveNamespaces = { ...autoNamespaces, ...namespaces };
    let evaluation: { results: QueryResult[]; error?: string };
    if (docType === "xml") {
      evaluation = evaluateXPath(document.getText(), query, {
        namespaces: effectiveNamespaces,
        compactPaths: config.compactPaths,
        outputLimit: config.outputLimit,
        tree: this.tree,
      });
    } else {
      evaluation = evaluateJSONPath(document.getText(), query, {
        compactPaths: config.compactPaths,
        outputLimit: config.outputLimit,
        tree: this.tree,
      });
    }

    if (evaluation.error) {
      vscode.window.showErrorMessage(evaluation.error);
      this.sendQueryStatus({ error: evaluation.error });
      this.statusBarItem.text = `$(alert) Query error`;
      this.statusBarItem.show();
      return;
    }

    const count = evaluation.results.length;
    this.sendQueryStatus({ count });

    if (count === 0) {
      this.statusBarItem.text = "$(search) 0 matches";
    } else if (count === 1) {
      this.statusBarItem.text = "$(search) 1 match";
    } else {
      this.statusBarItem.text = `$(search) ${count} matches`;
    }
    this.statusBarItem.show();

    if (evaluation.results.length) {
      this.focusFirstNodeResult(evaluation.results);
    }
  }

  private async rebuildTree(document: vscode.TextDocument): Promise<void> {
    if (!this.isSupportedDocument(document)) {
      this.tree = undefined;
      this.activeDocument = undefined;
      return;
    }

    const config = this.getViewerConfig();
    const treeResult = buildDocumentTree(
      document.getText(),
      this.getDocumentKind(document)!,
      {
        compactPaths: config.compactPaths,
        outputLimit: config.outputLimit,
        includeWhitespaceText: false,
      },
    );

    if (treeResult.error) {
      this.postMessage("treeError", { message: treeResult.error });
      return;
    }

    this.tree = treeResult.tree;
    this.activeDocument = document;
    this.treeVersion += 1;

    this.sendTreeSnapshot();
  }

  private focusFirstNodeResult(results: QueryResult[]) {
    if (!this.tree || !this.activeDocument) {
      return;
    }

    const firstMatch = results.find((result) => !!result.path);
    if (!firstMatch?.path) {
      return;
    }

    const nodeId = this.tree.pathToNodeId.get(firstMatch.path);
    if (!nodeId) {
      return;
    }

    const node = this.tree.nodes.get(nodeId);
    if (!node) {
      return;
    }

    this.ensureTreePathLoaded(node);

    this.lastSelectionNodeId = node.id;
    this.postMessage("selectInTree", {
      nodeId: node.id,
      version: this.treeVersion,
    });
    this.sendInspector(node);

    if (firstMatch.range) {
      this.revealNodeInEditor(node.id, { preserveFocus: true });
    }
  }

  private ensureTreePathLoaded(node: TreeNodeData) {
    if (!this.tree) {
      return;
    }

    const ancestors: TreeNodeData[] = [];
    let current: TreeNodeData | undefined = node;

    while (current?.parentId) {
      const parent = this.tree.nodes.get(current.parentId);
      if (!parent) {
        break;
      }
      ancestors.unshift(parent);
      current = parent;
    }

    for (const ancestor of ancestors) {
      this.sendChildren(ancestor.id, { force: true });
    }
  }

  private sendInitialState() {
    if (!this.panel || !this.tree || !this.activeDocument) {
      return;
    }

    const document = this.activeDocument;
    const docType = this.tree.documentType;
    const config = this.getViewerConfig();

    const roots = getChildNodeIds(this.tree);
    const rootNodes = getSerializedNodes(this.tree, roots);

    this.postMessage("init", {
      version: this.treeVersion,
      documentType: docType,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      rootNodes,
      config,
      queryPlaceholder: docType === "xml" ? "/root/item[1]" : "$.root.items[0]",
    });

    if (this.lastSelectionNodeId) {
      const node = this.tree.nodes.get(this.lastSelectionNodeId);
      if (node) {
        this.sendInspector(node);
      }
    }
  }

  private sendTreeSnapshot() {
    if (!this.panel || !this.tree) {
      return;
    }

    const rootIds = getChildNodeIds(this.tree);
    const nodes = getSerializedNodes(this.tree, rootIds);

    this.postMessage("treeUpdate", {
      version: this.treeVersion,
      rootNodes: nodes,
    });
  }

  private sendChildren(nodeId: string, _options: { force?: boolean } = {}) {
    if (!this.panel || !this.tree) {
      return;
    }

    const childIds = getChildNodeIds(this.tree, nodeId);
    const nodes = getSerializedNodes(this.tree, childIds);

    this.postMessage("treeChildren", {
      version: this.treeVersion,
      parentId: nodeId,
      nodes,
    });
  }

  private handleActiveEditorChange(editor: vscode.TextEditor | undefined) {
    if (!editor) {
      return;
    }

    if (!this.isSupportedDocument(editor.document)) {
      return;
    }

    this.activeDocument = editor.document;
    void this.rebuildTree(editor.document);
  }

  private handleSelectionChange(event: vscode.TextEditorSelectionChangeEvent) {
    if (!this.tree || !this.activeDocument) {
      return;
    }

    if (
      event.textEditor.document.uri.toString() !==
      this.activeDocument.uri.toString()
    ) {
      return;
    }

    if (this.selectionGuard > 0) {
      this.selectionGuard -= 1;
      return;
    }

    const active = event.selections[0]?.active;
    if (!active) {
      return;
    }

    const offset = this.activeDocument.offsetAt(active);
    const node = findNodeAtOffset(this.tree, offset);
    if (!node) {
      return;
    }

    this.lastSelectionNodeId = node.id;
    this.postMessage("selectInTree", {
      nodeId: node.id,
      version: this.treeVersion,
    });
    this.sendInspector(node);
    this.postMessage("clearQuery", {});
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent) {
    if (!this.activeDocument) {
      return;
    }

    if (event.document.uri.toString() !== this.activeDocument.uri.toString()) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      void this.rebuildTree(event.document);
    }, 300);
  }

  private handleDocumentClosed(document: vscode.TextDocument) {
    if (
      this.activeDocument &&
      document.uri.toString() === this.activeDocument.uri.toString()
    ) {
      this.tree = undefined;
      this.activeDocument = undefined;
      this.statusBarItem.hide();
      this.postMessage("documentClosed", {});
    }
  }

  private handleWebviewSelection(nodeId: string, revealInEditor: boolean) {
    if (!this.tree || !this.activeDocument) {
      return;
    }

    const node = this.tree.nodes.get(nodeId);
    if (!node) {
      return;
    }

    this.lastSelectionNodeId = node.id;
    this.sendInspector(node);
    this.postMessage("clearQuery", {});

    if (revealInEditor) {
      this.revealNodeInEditor(node.id, { preserveFocus: false });
    }
  }

  private async copyCurrentPath() {
    const editor = this.getRelevantEditor();
    if (!editor) {
      vscode.window.showErrorMessage(
        "Open an XML or JSON document before copying paths.",
      );
      return;
    }

    await this.rebuildTree(editor.document);

    if (!this.tree || !this.activeDocument) {
      vscode.window.showErrorMessage(
        "Unable to build tree for the current document.",
      );
      return;
    }

    const offset = editor.document.offsetAt(editor.selection.active);
    const node = findNodeAtOffset(this.tree, offset);
    if (!node) {
      vscode.window.showWarningMessage(
        "No matching node found at the current cursor position.",
      );
      return;
    }

    const pathToCopy = node.displayPath ?? node.path;
    await vscode.env.clipboard.writeText(pathToCopy);
    vscode.window.showInformationMessage(`Copied path: ${pathToCopy}`);
  }

  private async copyPathById(nodeId: string | undefined) {
    if (!this.tree || !nodeId) {
      return;
    }

    const node = this.tree.nodes.get(nodeId);
    if (!node) {
      return;
    }

    const pathToCopy = node.displayPath ?? node.path;
    await vscode.env.clipboard.writeText(pathToCopy);
    vscode.window.showInformationMessage(`Copied path: ${pathToCopy}`);
  }

  private async copyValueById(nodeId: string | undefined) {
    if (!this.tree || !this.activeDocument || !nodeId) {
      return;
    }

    const node = this.tree.nodes.get(nodeId);
    if (!node) {
      return;
    }

    let value = "";

    if (
      node.valueKind === "attribute" ||
      node.valueKind === "string" ||
      node.valueKind === "number" ||
      node.valueKind === "boolean" ||
      node.valueKind === "null" ||
      node.valueKind === "text"
    ) {
      value =
        node.value !== undefined && node.value !== null
          ? String(node.value)
          : this.extractText(node.range);
    } else if (node.range) {
      value = this.extractText(node.range);
    }

    if (!value) {
      vscode.window.showWarningMessage(
        "No value available to copy for the selected node.",
      );
      return;
    }

    await vscode.env.clipboard.writeText(value);
    vscode.window.showInformationMessage("Node value copied to clipboard.");
  }

  private async formatActiveDocument() {
    const editor = this.getRelevantEditor();
    if (!editor) {
      vscode.window.showErrorMessage(
        "Open an XML or JSON document before formatting.",
      );
      return;
    }

    const kind = this.getDocumentKind(editor.document);
    if (!kind) {
      vscode.window.showWarningMessage(
        "The active document is not XML or JSON.",
      );
      return;
    }

    if (editor.selection && !editor.selection.isEmpty) {
      await vscode.commands.executeCommand("editor.action.formatSelection");
    } else {
      await vscode.commands.executeCommand("editor.action.formatDocument");
    }

    vscode.window.setStatusBarMessage(
      kind === "xml" ? "Formatted XML document." : "Formatted JSON document.",
      1500,
    );
  }

  private async addNamespaceMapping(
    document: vscode.TextDocument,
    namespaces: Record<string, string>,
  ) {
    const prefix = await vscode.window.showInputBox({
      prompt: "Namespace prefix (e.g. ns)",
      placeHolder: "Prefix",
      validateInput: (value) => {
        if (!value.trim()) {
          return "Prefix cannot be empty.";
        }
        if (!/^[A-Za-z_][\w\-.]*$/.test(value.trim())) {
          return "Prefix must start with a letter or underscore and contain only letters, digits, underscores, hyphens, or periods.";
        }
        return undefined;
      },
    });

    if (!prefix) {
      return;
    }

    const uri = await vscode.window.showInputBox({
      prompt: `Namespace URI for prefix "${prefix}"`,
      placeHolder: "http://example.com/ns",
      validateInput: (value) =>
        value.trim() ? undefined : "URI cannot be empty.",
    });

    if (!uri) {
      return;
    }

    namespaces[prefix.trim()] = uri.trim();
    this.setNamespacesForDocument(document, namespaces);
    vscode.window.showInformationMessage(
      `Namespace prefix "${prefix.trim()}" saved.`,
    );
  }

  private async removeNamespaceMapping(
    document: vscode.TextDocument,
    namespaces: Record<string, string>,
  ) {
    const prefixes = Object.keys(namespaces);
    if (!prefixes.length) {
      vscode.window.showInformationMessage(
        "No namespace mappings are defined.",
      );
      return;
    }

    const prefix = await vscode.window.showQuickPick(prefixes, {
      placeHolder: "Select a prefix to remove",
    });

    if (!prefix) {
      return;
    }

    delete namespaces[prefix];
    this.setNamespacesForDocument(document, namespaces);
    vscode.window.showInformationMessage(
      `Namespace prefix "${prefix}" removed.`,
    );
  }

  private async clearNamespaceMappings(
    document: vscode.TextDocument,
    namespaces: Record<string, string>,
  ) {
    if (!Object.keys(namespaces).length) {
      vscode.window.showInformationMessage(
        "No namespace mappings are defined.",
      );
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      "Clear all namespace mappings?",
      { modal: true },
      "Clear",
    );

    if (confirm !== "Clear") {
      return;
    }

    this.namespaceState.delete(document.uri.toString());
    await this.saveNamespaceState();
    vscode.window.showInformationMessage("All namespace mappings cleared.");
  }

  private async manageNamespaces() {
    const document = this.getRelevantEditor()?.document ?? this.activeDocument;
    if (!document || document.languageId !== "xml") {
      vscode.window.showErrorMessage(
        "Open an XML document to manage namespaces.",
      );
      return;
    }

    const defaults = this.getViewerConfig().namespaces;
    const stored = this.getStoredNamespaces(document);
    const auto = this.tree?.namespaces ?? {};
    const combinedForDisplay = { ...auto, ...defaults, ...stored };
    const hasStored = Object.keys(stored).length > 0;

    interface NamespaceAction extends vscode.QuickPickItem {
      action: "add" | "remove" | "clear";
    }

    const actions: NamespaceAction[] = [
      {
        label: "Add namespace mapping",
        description: "Create or update a prefix → URI pair for this file",
        action: "add",
      },
    ];

    if (hasStored) {
      actions.push(
        {
          label: "Remove namespace mapping",
          description: "Delete an existing prefix in this file",
          action: "remove",
        },
        {
          label: "Clear all namespaces",
          description: "Remove every mapping for this file",
          action: "clear",
        },
      );
    }

    const pick = await vscode.window.showQuickPick(actions, {
      placeHolder: "Manage namespace mappings for this XML document",
    });

    if (!pick) {
      return;
    }

    switch (pick.action) {
      case "add":
        await this.addNamespaceMapping(document, stored);
        break;
      case "remove":
        await this.removeNamespaceMapping(document, stored);
        break;
      case "clear":
        await this.clearNamespaceMappings(document, stored);
        break;
    }
  }

  private setNamespacesForDocument(
    document: vscode.TextDocument,
    namespaces: Record<string, string>,
  ) {
    const filtered = Object.fromEntries(
      Object.entries(namespaces).filter(([, value]) => value && value.trim()),
    );

    if (Object.keys(filtered).length > 0) {
      this.namespaceState.set(document.uri.toString(), filtered);
    } else {
      this.namespaceState.delete(document.uri.toString());
    }

    void this.saveNamespaceState();
  }

  private getNamespacesForDocument(
    document: vscode.TextDocument,
  ): Record<string, string> {
    if (document.languageId !== "xml") {
      return {};
    }

    const defaults = this.getViewerConfig().namespaces;
    const specific = this.namespaceState.get(document.uri.toString());
    return specific ? { ...defaults, ...specific } : { ...defaults };
  }

  private async saveNamespaceState() {
    const serializable: Record<string, Record<string, string>> = {};
    for (const [uri, map] of this.namespaceState.entries()) {
      if (Object.keys(map).length > 0) {
        serializable[uri] = map;
      }
    }
    await this.context.workspaceState.update(
      "unifiedQuery.namespacesState",
      serializable,
    );
  }

  private getStoredNamespaces(
    document: vscode.TextDocument,
  ): Record<string, string> {
    if (document.languageId !== "xml") {
      return {};
    }
    const stored = this.namespaceState.get(document.uri.toString());
    return stored ? { ...stored } : {};
  }

  private async revealNodeInEditor(
    nodeId: string | undefined,
    options: { preserveFocus?: boolean } = {},
  ) {
    if (!this.tree || !this.activeDocument || !nodeId) {
      return;
    }

    const node = this.tree.nodes.get(nodeId);
    if (!node || !node.selectionRange) {
      return;
    }

    let editor = this.getRelevantEditor();
    if (
      !editor ||
      editor.document.uri.toString() !== this.activeDocument.uri.toString()
    ) {
      // Use await to ensure we capture the editor instance even when webview has focus
      editor = await vscode.window.showTextDocument(this.activeDocument, {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: !!options.preserveFocus,
      });
    }

    const finalEditor = editor;
    if (
      !finalEditor ||
      finalEditor.document.uri.toString() !== this.activeDocument.uri.toString()
    ) {
      return;
    }

    const range = new vscode.Range(
      finalEditor.document.positionAt(node.selectionRange.start),
      finalEditor.document.positionAt(node.selectionRange.end),
    );

    this.selectionGuard = 1;
    finalEditor.selection = new vscode.Selection(range.start, range.end);
    finalEditor.revealRange(
      range,
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  private sendInspector(node: TreeNodeData) {
    if (!this.panel || !this.activeDocument) {
      return;
    }

    const payload: InspectorPayload = {
      id: node.id,
      label: node.label,
      path: node.path,
      displayPath: node.displayPath,
      kind: node.kind,
      valueKind: node.valueKind,
      preview: node.preview,
      valueText: this.computeValueText(node),
      range: this.convertRangeToSerializable(node.range, this.activeDocument),
      selectionRange: this.convertRangeToSerializable(
        node.selectionRange,
        this.activeDocument,
      ),
    };

    this.postMessage("inspectorUpdate", { node: payload });
  }

  private computeValueText(node: TreeNodeData): string {
    if (!this.activeDocument) {
      return node.preview;
    }

    if (
      node.valueKind === "attribute" ||
      node.valueKind === "string" ||
      node.valueKind === "number" ||
      node.valueKind === "boolean" ||
      node.valueKind === "null" ||
      node.valueKind === "text"
    ) {
      return node.value !== undefined && node.value !== null
        ? String(node.value)
        : this.extractText(node.range);
    }

    if (node.valueKind === "element") {
      const element = node.domNode as Element | undefined;
      const hasElementChildren = element
        ? this.elementHasElementChildren(element)
        : false;

      if (!hasElementChildren) {
        const textValue = node.value ?? element?.textContent ?? "";
        return typeof textValue === "string"
          ? textValue
          : String(textValue ?? "");
      }

      if (node.range) {
        const xmlSnippet = this.extractText(node.range).trim();
        if (xmlSnippet) {
          return xmlSnippet;
        }
      }

      if (element) {
        return element.toString();
      }
    }

    if (node.range) {
      const raw = this.extractText(node.range);
      return raw.trim() || raw;
    }

    return node.preview;
  }

  private extractText(range: OffsetRange | undefined): string {
    if (!range || !this.activeDocument) {
      return "";
    }

    const start = this.activeDocument.positionAt(range.start);
    const end = this.activeDocument.positionAt(range.end);
    return this.activeDocument.getText(new vscode.Range(start, end));
  }

  private elementHasElementChildren(element: Element): boolean {
    for (let i = 0; i < element.childNodes.length; i++) {
      if (element.childNodes[i].nodeType === 1) {
        return true;
      }
    }
    return false;
  }

  private getRelevantEditor(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && this.isSupportedDocument(editor.document)) {
      this.activeDocument = editor.document;
      return editor;
    }

    if (this.activeDocument) {
      const match = vscode.window.visibleTextEditors.find(
        (ed) =>
          ed.document.uri.toString() === this.activeDocument?.uri.toString(),
      );
      if (match) {
        return match;
      }
    }

    return undefined;
  }

  private getDocumentKind(
    document: vscode.TextDocument,
  ): DocumentKind | undefined {
    if (document.languageId === "xml") {
      return "xml";
    }
    if (document.languageId === "json" || document.languageId === "jsonc") {
      return "json";
    }
    return undefined;
  }

  private isSupportedDocument(document: vscode.TextDocument): boolean {
    return Boolean(this.getDocumentKind(document));
  }

  private getViewerConfig(): ViewerConfig {
    const config = vscode.workspace.getConfiguration("unifiedQuery");
    return {
      namespaces: config.get<Record<string, string>>("namespaces", {}),
      compactPaths: config.get<boolean>("compactPaths", false),
      outputLimit: config.get<number>("outputLimit", 200),
    };
  }

  private sendQueryStatus(payload: {
    count?: number;
    error?: string;
    message?: string;
  }) {
    this.postMessage("queryStatus", payload);
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(
      this.context.extensionPath,
      "media",
      "viewer.html",
    );
    let html = fs.readFileSync(htmlPath, "utf8");

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.mediaRoot, "viewer.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.mediaRoot, "viewer.css"),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https:`,
      `script-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
    html = html.replace(/\{\{csp\}\}/g, csp);
    html = html.replace(/\{\{scriptUri\}\}/g, scriptUri.toString());
    html = html.replace(/\{\{styleUri\}\}/g, styleUri.toString());

    return html;
  }

  private postMessage(type: string, payload: any) {
    if (!this.panel) {
      return;
    }

    this.panel.webview.postMessage({
      type,
      ...payload,
    });
  }

  private convertRangeToSerializable(
    range: OffsetRange | undefined,
    document: vscode.TextDocument,
  ): SerializedRange | undefined {
    if (!range) {
      return undefined;
    }

    const start = document.positionAt(range.start);
    const end = document.positionAt(range.end);

    return {
      start: { line: start.line, character: start.character },
      end: { line: end.line, character: end.character },
    };
  }
}
