"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mayReleaseEntryRiskReservation } = require("../index");

test("risk reservation is released only before an order or after definitive rejection", () => {
  assert.equal(mayReleaseEntryRiskReservation({ entryOrderAttempted: false }), true);
  assert.equal(
    mayReleaseEntryRiskReservation({
      entryOrderAttempted: true,
      state: "ENTRY_REJECTED",
    }),
    true,
  );
  for (const state of ["ENTRY_UNKNOWN", "ORDER_SUBMITTING", "OPEN", "CLOSED"])
    assert.equal(
      mayReleaseEntryRiskReservation({ entryOrderAttempted: true, state }),
      false,
      state,
    );
});
