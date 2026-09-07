const { R } = require("redbean-node");
const dayjs = require("dayjs");
const {
  log,
  SQL_DATETIME_FORMAT,
  DIAGNOSTIC_STATUS_RUNNING,
  DIAGNOSTIC_STATUS_COMPLETED,
  DIAGNOSTIC_STATUS_TIMED_OUT,
} = require("../../src/util");

const DIAGNOSTIC_RESULT_STATUS = {
  UP: 0,
  DOWN: 1,
  ERROR: 2,
  TIMEOUT: 3,
};

/**
 * Get diagnostic chain for a primary monitor.
 * @param {number} monitorID ID of the primary monitor
 * @returns {Promise<{chain: object|null, items: Array<{id: number, monitor_id: number, order: number}>}|null>} Chain config with ordered items, or null
 */
async function getChainForMonitor(monitorID) {
  const chain = await R.findOne("diagnostic_chain", " monitor_id = ? ", [monitorID]);
  if (!chain) {
    return null;
  }

  const items = await R.getAll(
    "SELECT id, monitor_id, `order` FROM diagnostic_item WHERE chain_id = ? ORDER BY `order` ASC",
    [chain.id]
  );

  return {
    chain: {
      id: chain.id,
      monitor_id: chain.monitor_id,
      enabled: chain.enabled === 1 || chain.enabled === true,
      timeout: Number(chain.timeout),
    },
    items: items.map((item) => ({
      id: item.id,
      monitor_id: item.monitor_id,
      order: item.order,
    })),
  };
}

/**
 * Upsert diagnostic chain for a primary monitor.
 * @param {number} monitorID ID of the primary monitor
 * @param {Array<{monitor_id: number}>} items Ordered diagnostic monitor references
 * @param {number} timeoutSeconds Global timeout in seconds (0 = no limit)
 * @returns {Promise<void>} Resolves when the chain is stored
 */
async function setChainForMonitor(monitorID, items, timeoutSeconds) {
  const enabled = items.length > 0;

  let chain = await R.findOne("diagnostic_chain", " monitor_id = ? ", [monitorID]);
  if (!chain) {
    chain = R.dispense("diagnostic_chain");
    chain.monitor_id = monitorID;
  }

  chain.enabled = enabled ? 1 : 0;
  chain.timeout = timeoutSeconds || 0;
  await R.store(chain);

  await R.exec("DELETE FROM diagnostic_item WHERE chain_id = ?", [chain.id]);

  if (items.length === 0) {
    return;
  }

  const insertValues = items
    .map((item, index) => [chain.id, item.monitor_id, index + 1])
    .flat();

  if (insertValues.length > 0) {
    await R.exec(
      `INSERT INTO diagnostic_item (chain_id, monitor_id, \`order\`) VALUES ${insertValues
        .map((_) => "(?, ?, ?)")
        .join(",")}`,
      insertValues
    );
  }
}

/**
 * Delete diagnostic chain for a primary monitor (also cascades via FK).
 * @param {number} monitorID ID of the primary monitor
 * @returns {Promise<void>} Resolves when the chain is removed
 */
async function deleteChainForMonitor(monitorID) {
  const chain = await R.findOne("diagnostic_chain", " monitor_id = ? ", [monitorID]);
  if (chain) {
    await R.trash(chain);
  }
}

/**
 * Given a list of diagnostic monitor IDs (for a chain being saved),
 * validate that they are real, same-user, non-group, active monitors.
 * @param {number} userID ID of the user owning the primary monitor
 * @param {Array<{monitor_id: number}>} items Diagnostic monitor references to validate
 * @returns {Promise<Array<{monitor_id: number, name: string, pathName: string}>>} Validated items in order
 */
async function validateDiagnosticItems(userID, items) {
  if (items.length === 0) {
    return [];
  }

  const ids = items.map((item) => item.monitor_id);

  const rows = await R.getAll(
    `SELECT m.id, m.name, m.type, m.active, m.user_id
     FROM monitor m
     WHERE m.id IN (${ids.map((_) => "?").join(",")})`,
    ids
  );

  const byId = new Map(rows.map((row) => [row.id, row]));

  const result = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const row = byId.get(item.monitor_id);
    if (!row) {
      throw new Error(`Diagnostic monitor #${item.monitor_id} does not exist.`);
    }
    if (row.user_id !== userID) {
      throw new Error(`Diagnostic monitor #${item.monitor_id} is not owned by you.`);
    }
    if (row.type === "group") {
      throw new Error(`Diagnostic monitor #${item.monitor_id} cannot be a group monitor.`);
    }
    if (row.active === 0 || row.active === false) {
      throw new Error(`Diagnostic monitor #${item.monitor_id} is not active.`);
    }
    if (result.some((r) => r.monitor_id === item.monitor_id)) {
      throw new Error(`Duplicate diagnostic monitor #${item.monitor_id}.`);
    }

    result.push({
      monitor_id: row.id,
      name: row.name,
      pathName: row.name,
    });
  }

  return result;
}

/**
 * Create a diagnostic run for a chain and return run id.
 * @param {number} chainID ID of the chain this run belongs to
 * @returns {Promise<number>} ID of the created run
 */
async function createRun(chainID) {
  const run = R.dispense("diagnostic_run");
  run.chain_id = chainID;
  run.started_at = dayjs.utc().format(SQL_DATETIME_FORMAT);
  run.status = DIAGNOSTIC_STATUS_RUNNING;
  await R.store(run);
  return run.id;
}

/**
 * Finish a diagnostic run.
 * @param {number} runID ID of the run to finish
 * @param {number} status Final run status (completed/timed out)
 * @returns {Promise<void>} Resolves when the run is updated
 */
async function finishRun(runID, status) {
  const run = await R.findOne("diagnostic_run", " id = ? ", [runID]);
  if (!run) {
    log.warn("diagnostic", `diagnostic_run #${runID} not found when finishing`);
    return;
  }

  run.status = status;
  run.finished_at = dayjs.utc().format(SQL_DATETIME_FORMAT);
  await R.store(run);
}

/**
 * Record a diagnostic result for a run.
 * @param {number} runID ID of the run the result belongs to
 * @param {number} monitorID ID of the diagnostic monitor
 * @param {number} status Result status (UP/DOWN/ERROR/TIMEOUT)
 * @param {number|null} ping Response time in ms, if measurable
 * @returns {Promise<void>} Resolves when the result is stored
 */
async function addResult(runID, monitorID, status, ping) {
  const startedAt = dayjs.utc().format(SQL_DATETIME_FORMAT);
  const bean = R.dispense("diagnostic_result");
  bean.run_id = runID;
  bean.monitor_id = monitorID;
  bean.status = status;
  bean.ping = ping;
  bean.started_at = startedAt;
  bean.finished_at = startedAt;
  await R.store(bean);
}

/**
 * Get latest diagnostic results for a primary monitor (any chain).
 * Returns results from the most recent completed/timed_out run.
 * @param {number} monitorID ID of the primary monitor
 * @returns {Promise<Array<object>>} Results of the latest finished run, empty if none
 */
async function getLatestResultsForMonitor(monitorID) {
  const rows = await R.getAll(
    `SELECT dr.id AS run_id,
            dr.status AS run_status,
            dr.started_at AS run_started_at,
            dr.finished_at AS run_finished_at,
            drm.id AS result_id,
            drm.monitor_id AS monitor_id,
            m.name AS monitor_name,
            drm.status AS status,
            drm.ping AS ping,
            drm.started_at AS started_at,
            drm.finished_at AS finished_at
     FROM diagnostic_result drm
     JOIN diagnostic_run dr ON dr.id = drm.run_id
     JOIN diagnostic_chain dc ON dc.id = dr.chain_id
     LEFT JOIN monitor m ON m.id = drm.monitor_id
     WHERE dc.monitor_id = ?
     ORDER BY dr.started_at DESC, drm.id DESC`,
    [monitorID]
  );

  const runs = new Map();
  for (const row of rows) {
    if (!runs.has(row.run_id)) {
      runs.set(row.run_id, {
        run_id: row.run_id,
        run_status: row.run_status,
        run_started_at: row.run_started_at,
        run_finished_at: row.run_finished_at,
        results: [],
      });
    }
    runs.get(row.run_id).results.push({
      result_id: row.result_id,
      monitor_id: row.monitor_id,
      monitor_name: row.monitor_name,
      status: row.status,
      ping: row.ping,
      started_at: row.started_at,
      finished_at: row.finished_at,
    });
  }

  const sortedRuns = Array.from(runs.values()).sort((a, b) => {
    return dayjs(b.run_started_at).valueOf() - dayjs(a.run_started_at).valueOf();
  });

  const latestRun = sortedRuns.find(
    (run) => run.run_status === DIAGNOSTIC_STATUS_COMPLETED ||
             run.run_status === DIAGNOSTIC_STATUS_TIMED_OUT
  ) || sortedRuns[0];

  if (!latestRun) {
    return [];
  }

  return latestRun.results.map((r) => ({
    result_id: r.result_id,
    monitor_id: r.monitor_id,
    monitor_name: r.monitor_name,
    status: r.status,
    ping: r.ping,
    started_at: r.started_at,
    finished_at: r.finished_at,
  }));
}

/**
 * Get the diagnostic chain configuration for a monitor, with the display
 * name of each diagnostic monitor resolved. Used by the edit form and UI.
 * @param {number} monitorID ID of the primary monitor
 * @returns {Promise<{enabled: boolean, timeout: number, items: Array<{monitor_id: number, name: string}>}|null>} Chain config with display names, or null
 */
async function getChainConfigForMonitor(monitorID) {
  const chain = await R.findOne("diagnostic_chain", " monitor_id = ? ", [monitorID]);
  if (!chain) {
    return null;
  }

  const items = await R.getAll(
    `SELECT di.monitor_id, m.name FROM diagnostic_item di LEFT JOIN monitor m ON m.id = di.monitor_id WHERE di.chain_id = ? ORDER BY di.\`order\` ASC`,
    [chain.id]
  );

  return {
    enabled: chain.enabled === 1 || chain.enabled === true,
    timeout: Number(chain.timeout),
    items: items.map((item) => ({
      monitor_id: item.monitor_id,
      name: item.name,
    })),
  };
}

module.exports = {
  DIAGNOSTIC_RESULT_STATUS,
  DIAGNOSTIC_STATUS_RUNNING,
  DIAGNOSTIC_STATUS_COMPLETED,
  DIAGNOSTIC_STATUS_TIMED_OUT,
  getChainForMonitor,
  getChainConfigForMonitor,
  setChainForMonitor,
  deleteChainForMonitor,
  validateDiagnosticItems,
  createRun,
  finishRun,
  addResult,
  getLatestResultsForMonitor,
};
