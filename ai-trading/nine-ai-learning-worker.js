"use strict";
// CPU-heavy policy evaluation cannot block live position protection/timeouts.
const { parentPort, workerData } = require("node:worker_threads");
const { trainCandidate } = require("./nine-ai-offline-learning");
try {
  parentPort.postMessage({
    result: trainCandidate(workerData.rows, workerData.champion),
  });
} catch (error) {
  parentPort.postMessage({ error: String(error.message || error) });
}
