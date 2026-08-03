import assert from "node:assert/strict";
import test from "node:test";

import { editorialWindowProgressMessage } from "../progress.js";

test("editorial progress exposes completed and total windows instead of a decorative percent", () => {
  assert.equal(
    editorialWindowProgressMessage("火山 Seed Pro", 7, 35),
    "火山 Seed Pro 独立分析窗口 7/35 已完成。",
  );
});

test("editorial progress rejects impossible counts", () => {
  assert.throws(
    () => editorialWindowProgressMessage("Kimi K3", 36, 35),
    /counts are invalid/,
  );
});
