(() => {
  const vscode = acquireVsCodeApi();

  /**
   * @typedef {import('../src/tree').SerializedTreeNode} SerializedTreeNode
   */

  /**
   * @typedef {{
   *   expanded: boolean;
   *   childrenLoaded: boolean;
   *   children: string[];
   *   parentId: string | null;
   *   hasChildren: boolean;
   * }} NodeMeta
   */

  const state = {
    version: 0,
    nodes: new Map(),
    /** @type {Map<string, SerializedTreeNode>} */ meta: new Map(),
    /** @type {Map<string, NodeMeta>} */ rootIds: [],
    selectedNodeId: undefined,
    filterText: "",
    documentType: "xml",
    config: undefined,
    suppressSelectionNotification: false,
  };

  const elements = {
    queryInput: /** @type {HTMLInputElement} */ (
      document.getElementById("queryInput")
    ),
    evaluateBtn: /** @type {HTMLButtonElement} */ (
      document.getElementById("evaluateBtn")
    ),
    queryFeedback: document.getElementById("queryFeedback"),
    treeFilter: /** @type {HTMLInputElement} */ (
      document.getElementById("treeFilter")
    ),
    treeContainer: document.getElementById("treeContainer"),
    treeScroll: document.getElementById("treeScroll"),
    copyPathBtn: /** @type {HTMLButtonElement} */ (
      document.getElementById("copyPathBtn")
    ),
    copyValueBtn: /** @type {HTMLButtonElement} */ (
      document.getElementById("copyValueBtn")
    ),
    revealBtn: /** @type {HTMLButtonElement} */ (
      document.getElementById("revealBtn")
    ),
    pathDisplay: /** @type {HTMLInputElement} */ (
      document.getElementById("pathDisplay")
    ),
    valuePreview: /** @type {HTMLPreElement} */ (
      document.getElementById("valuePreview")
    ),
  };

  function resetState() {
    state.nodes.clear();
    state.meta.clear();
    state.rootIds = [];
    state.selectedNodeId = undefined;
    state.filterText = "";

    elements.treeFilter.value = "";
    elements.treeContainer.innerHTML = "";
    elements.pathDisplay.value = "";
    elements.valuePreview.textContent = "";
    elements.copyPathBtn.disabled = true;
    elements.copyValueBtn.disabled = true;
    elements.revealBtn.disabled = true;
  }

  function ensureMeta(id, overrides = {}) {
    let meta = state.meta.get(id);
    if (!meta) {
      meta = {
        expanded: false,
        childrenLoaded: false,
        children: [],
        parentId: null,
        hasChildren: false,
        ...overrides,
      };
      state.meta.set(id, meta);
    } else {
      Object.assign(meta, overrides);
    }
    return meta;
  }

  function upsertNode(node) {
    state.nodes.set(node.id, node);
    ensureMeta(node.id, {
      parentId: node.parentId ?? null,
      hasChildren: node.hasChildren,
    });
  }

  function renderTree() {
    const container = elements.treeContainer;
    container.innerHTML = "";

    const fragment = document.createDocumentFragment();
    for (const rootId of state.rootIds) {
      const node = state.nodes.get(rootId);
      if (!node) {
        continue;
      }
      const rows = collectVisibleRows(node.id, 0);
      for (const row of rows) {
        fragment.appendChild(createTreeRow(row.node, row.depth));
      }
    }

    container.appendChild(fragment);
    highlightSelectedRow();
  }

  function collectVisibleRows(nodeId, depth) {
    const node = state.nodes.get(nodeId);
    if (!node) {
      return [];
    }

    const meta = ensureMeta(nodeId);
    const filterText = state.filterText;
    const pathText = (node.displayPath || node.path || "").toLowerCase();
    const matchesFilter = filterText
      ? node.label.toLowerCase().includes(filterText) ||
        pathText.includes(filterText)
      : true;

    let childrenRows = [];
    let childHasMatch = false;
    if (meta.childrenLoaded) {
      for (const childId of meta.children) {
        const rows = collectVisibleRows(childId, depth + 1);
        if (rows.length) {
          childrenRows = childrenRows.concat(rows);
        }
        childHasMatch = childHasMatch || rows.some((row) => row.matchesFilter);
      }
    }

    const branchMatches = matchesFilter || childHasMatch;
    const shouldRender = !filterText || branchMatches;
    const result = [];

    if (shouldRender) {
      result.push({ node, depth, matchesFilter });

      const shouldShowChildren =
        meta.childrenLoaded &&
        ((meta.expanded && !filterText) || (filterText && childHasMatch));

      if (shouldShowChildren) {
        result.push(...childrenRows);
      }
    }

    return result;
  }

  function createTreeRow(node, depth) {
    const meta = ensureMeta(node.id);
    const row = document.createElement("div");
    row.className = "tree-row";
    row.dataset.nodeId = node.id;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(depth + 1));
    row.style.paddingLeft = `${depth * 16}px`;

    if (node.id === state.selectedNodeId) {
      row.classList.add("selected");
    }

    const toggle = document.createElement("button");
    toggle.className = "toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-hidden", "true");
    toggle.tabIndex = -1;

    if (node.hasChildren) {
      toggle.classList.add(meta.expanded ? "expanded" : "collapsed");
    } else {
      toggle.classList.add("no-children");
      toggle.disabled = true;
    }

    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleNode(node.id);
    });

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = node.label;

    const description = document.createElement("span");
    description.className = "description";
    if (node.preview) {
      description.textContent = ` ${node.preview}`;
    }

    row.appendChild(toggle);
    row.appendChild(label);
    row.appendChild(description);

    row.addEventListener("click", () => selectNode(node.id, { notify: true }));
    row.addEventListener("dblclick", () => {
      if (node.hasChildren) {
        toggleNode(node.id);
      } else {
        vscode.postMessage({ type: "revealNode", nodeId: node.id });
      }
    });

    return row;
  }

  function toggleNode(nodeId) {
    const meta = ensureMeta(nodeId);
    meta.expanded = !meta.expanded;

    if (meta.expanded && !meta.childrenLoaded && meta.hasChildren) {
      vscode.postMessage({ type: "requestChildren", nodeId });
    }

    renderTree();
  }

  function selectNode(nodeId, options = { notify: false }) {
    state.selectedNodeId = nodeId;
    highlightSelectedRow();
    updateActionButtons();

    const node = state.nodes.get(nodeId);
    if (node) {
      elements.pathDisplay.value = node.displayPath || node.path;
    }

    if (options.notify && !state.suppressSelectionNotification) {
      vscode.postMessage({ type: "selectNode", nodeId });
    }
  }

  function highlightSelectedRow() {
    const rows = elements.treeContainer.querySelectorAll(".tree-row");
    rows.forEach((row) => {
      if (row.dataset.nodeId === state.selectedNodeId) {
        row.classList.add("selected");
        row.setAttribute("aria-selected", "true");
        // Scroll into view if needed
        const rect = row.getBoundingClientRect();
        const parentRect = elements.treeScroll.getBoundingClientRect();
        if (rect.top < parentRect.top || rect.bottom > parentRect.bottom) {
          row.scrollIntoView({ block: "nearest" });
        }
      } else {
        row.classList.remove("selected");
        row.removeAttribute("aria-selected");
      }
    });
  }

  function updateActionButtons() {
    const hasSelection = Boolean(state.selectedNodeId);
    elements.copyPathBtn.disabled = !hasSelection;
    elements.copyValueBtn.disabled = !hasSelection;
    elements.revealBtn.disabled = !hasSelection;
  }

  function applyInspector(node) {
    if (!node) {
      elements.pathDisplay.value = "";
      elements.valuePreview.textContent = "";
      state.selectedNodeId = undefined;
      updateActionButtons();
      return;
    }

    state.selectedNodeId = node.id;
    elements.pathDisplay.value = node.path;
    if (node.displayPath) {
      elements.pathDisplay.value = node.displayPath;
    }
    elements.valuePreview.textContent = node.valueText ?? node.preview ?? "";
    updateActionButtons();
    highlightSelectedRow();
  }

  function expandAncestors(nodeId) {
    let currentId = nodeId;
    while (currentId) {
      const meta = ensureMeta(currentId);
      meta.expanded = true;
      currentId = meta.parentId ?? undefined;
    }
  }

  function handleMessage(event) {
    const message = event.data;
    switch (message.type) {
      case "init": {
        resetState();
        state.version = message.version;
        state.documentType = message.documentType;
        state.config = message.config;
        state.rootIds = message.rootNodes.map((node) => node.id);
        message.rootNodes.forEach((node) => upsertNode(node));
        renderTree();
        if (message.queryPlaceholder) {
          elements.queryInput.placeholder = message.queryPlaceholder;
        }
        break;
      }
      case "treeUpdate": {
        const expandedIds = Array.from(state.meta.entries())
          .filter(([_, meta]) => meta.expanded)
          .map(([id]) => id);

        resetState();
        state.version = message.version;
        state.rootIds = message.rootNodes.map((node) => node.id);
        message.rootNodes.forEach((node) => upsertNode(node));

        expandedIds.forEach((id) => {
          if (state.nodes.has(id)) {
            ensureMeta(id).expanded = true;
          }
        });

        renderTree();
        break;
      }
      case "treeChildren": {
        if (message.version && message.version !== state.version) {
          break;
        }
        const parentId = message.parentId;
        const meta = ensureMeta(parentId);
        meta.children = message.nodes.map((node) => node.id);
        meta.childrenLoaded = true;

        message.nodes.forEach((node) => {
          upsertNode(node);
        });

        renderTree();
        break;
      }
      case "selectInTree": {
        if (message.version && message.version !== state.version) {
          break;
        }
        state.suppressSelectionNotification = true;
        expandAncestors(message.nodeId);
        selectNode(message.nodeId, { notify: false });
        state.suppressSelectionNotification = false;
        renderTree();
        break;
      }
      case "inspectorUpdate": {
        applyInspector(message.node);
        break;
      }
      case "treeError": {
        elements.queryFeedback.textContent =
          message.message ?? "Failed to parse document.";
        break;
      }
      case "documentClosed": {
        resetState();
        break;
      }
      case "queryStatus": {
        if (message.error) {
          elements.queryFeedback.textContent = message.error;
        } else if (typeof message.count === "number") {
          elements.queryFeedback.textContent =
            message.count === 1 ? "1 result" : `${message.count} results`;
        } else if (typeof message.message === "string") {
          elements.queryFeedback.textContent = message.message;
        } else {
          elements.queryFeedback.textContent = "";
        }
        break;
      }
      case "clearQuery": {
        clearQueryInput();
        break;
      }
      default:
        break;
    }
  }

  elements.evaluateBtn.addEventListener("click", () => {
    const query = elements.queryInput.value.trim();
    if (!query) {
      elements.queryFeedback.textContent = "Enter a query expression.";
      return;
    }
    elements.queryFeedback.textContent = "Evaluating…";
    vscode.postMessage({ type: "evaluateQuery", query });
  });

  elements.queryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      elements.evaluateBtn.click();
    }
  });

  elements.treeFilter.addEventListener("input", () => {
    state.filterText = elements.treeFilter.value.trim().toLowerCase();
    renderTree();
  });

  elements.copyPathBtn.addEventListener("click", () => {
    if (state.selectedNodeId) {
      vscode.postMessage({ type: "copyPath", nodeId: state.selectedNodeId });
    }
  });

  elements.copyValueBtn.addEventListener("click", () => {
    if (state.selectedNodeId) {
      vscode.postMessage({ type: "copyValue", nodeId: state.selectedNodeId });
    }
  });

  elements.revealBtn.addEventListener("click", () => {
    if (state.selectedNodeId) {
      vscode.postMessage({ type: "revealNode", nodeId: state.selectedNodeId });
    }
  });

  window.addEventListener("message", handleMessage);

  vscode.postMessage({ type: "ready" });

  function clearQueryInput() {
    elements.queryInput.value = "";
    elements.queryFeedback.textContent = "";
  }
})();
