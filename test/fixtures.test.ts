import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkRecordings, sdkRecords } from "./support/fixtures.ts";

test("every record of a recorded stream names its type", () => {
  const recordings = sdkRecordings();
  assert.ok(recordings.length > 0);
  for (const name of recordings) {
    const records = sdkRecords(name);
    assert.ok(records.length > 0, name);
    for (const record of records) assert.equal(typeof record.type, "string", name);
  }
});
