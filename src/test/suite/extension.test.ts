import * as assert from "assert";
import * as vscode from "vscode";

suite("UnifiedXJPath (Dansharp) Viewer Integration", () => {
  test("activates extension and registers commands", async () => {
    const extension = vscode.extensions.getExtension(
      "DanielJonathan.unifiedxjpath-viewer",
    );
    assert.ok(extension, "Extension should be available");

    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    const expected = [
      "unifiedxjpath.openViewer",
      "unifiedxjpath.evaluateQuery",
      "unifiedxjpath.copyPath",
      "unifiedxjpath.formatDocument",
      "unifiedxjpath.manageNamespaces",
    ];

    for (const command of expected) {
      assert.ok(
        commands.includes(command),
        `Expected command ${command} to be registered`,
      );
    }
  });

  test("opens viewer for XML documents", async () => {
    const extension = vscode.extensions.getExtension(
      "DanielJonathan.unifiedxjpath-viewer",
    );
    assert.ok(extension, "Extension should be available");
    await extension.activate();

    const xmlDoc = await vscode.workspace.openTextDocument({
      language: "xml",
      content:
        '<catalog><book id="bk101"><title>Integration Testing</title></book></catalog>',
    });

    await vscode.window.showTextDocument(xmlDoc);

    await vscode.commands.executeCommand("unifiedxjpath.openViewer");

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("formats JSON document via format command", async () => {
    const extension = vscode.extensions.getExtension(
      "DanielJonathan.unifiedxjpath-viewer",
    );
    assert.ok(extension, "Extension should be available");
    await extension.activate();

    const original = '{"foo":1,"bar":2}';
    const doc = await vscode.workspace.openTextDocument({
      language: "json",
      content: original,
    });

    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(
      new vscode.Position(0, 0),
      new vscode.Position(0, 0),
    );

    await vscode.commands.executeCommand("unifiedxjpath.formatDocument");
    await vscode.workspace.saveAll();

    const formatted = doc.getText();
    assert.notStrictEqual(
      formatted,
      original,
      "Formatting should change JSON structure",
    );

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});
