import * as path from "path";
import {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    const vscodeExecutablePath = await downloadAndUnzipVSCode({
      version: "1.80.0",
    });
    const cliPath =
      resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);

    await runTests({
      vscodeExecutablePath: cliPath,
      extensionDevelopmentPath,
      extensionTestsPath,
    });
  } catch (err) {
    console.error("Failed to run tests", err);
    process.exit(1);
  }
}

main();
