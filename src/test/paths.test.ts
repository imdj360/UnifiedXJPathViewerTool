import * as assert from "assert";
import { ensureDefaultXPathIndexes } from "../paths";

suite("ensureDefaultXPathIndexes", () => {
  test("adds default indexes to simple absolute paths", () => {
    const input = "/ShipmentConfirmation/Orders/OrderItems/Sequence";
    const expected =
      "/ShipmentConfirmation[1]/Orders[1]/OrderItems[1]/Sequence[1]";
    assert.strictEqual(ensureDefaultXPathIndexes(input), expected);
  });

  test("leaves existing predicates intact", () => {
    const input = "/ShipmentConfirmation[2]/Orders/OrderItems[3]/Sequence";
    const expected =
      "/ShipmentConfirmation[2]/Orders[1]/OrderItems[3]/Sequence[1]";
    assert.strictEqual(ensureDefaultXPathIndexes(input), expected);
  });

  test("preserves attribute steps and text nodes without modification", () => {
    assert.strictEqual(
      ensureDefaultXPathIndexes("/ShipmentConfirmation/Orders/@id"),
      "/ShipmentConfirmation[1]/Orders[1]/@id",
    );

    assert.strictEqual(
      ensureDefaultXPathIndexes("/ShipmentConfirmation/Orders/text()"),
      "/ShipmentConfirmation[1]/Orders[1]/text()",
    );
  });

  test("returns original expression for complex paths", () => {
    const expressions = [
      "relative/path",
      "/ShipmentConfirmation//Order",
      "/ShipmentConfirmation/Orders[price>10]/OrderItems",
      "/ShipmentConfirmation/Orders[position()=2]",
    ];

    for (const expr of expressions) {
      assert.strictEqual(ensureDefaultXPathIndexes(expr), expr);
    }
  });
});
