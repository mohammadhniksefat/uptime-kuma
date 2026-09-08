const { R } = require("redbean-node");
const dayjs = require("dayjs");
const {
    log,
    SQL_DATETIME_FORMAT,
    WORKFLOW_STATUS_RUNNING,
    WORKFLOW_STATUS_SUCCESS,
    WORKFLOW_STATUS_FAILED,
    WORKFLOW_STATUS_TIMED_OUT,
    WORKFLOW_STEP_STATUS_SUCCESS,
    WORKFLOW_STEP_STATUS_FAILED,
    WORKFLOW_STEP_STATUS_SKIPPED,
    HTTP_WORKFLOW_METHODS,
    HTTP_WORKFLOW_ASSERTION_TYPES,
    HTTP_WORKFLOW_STATUS_OPERATORS,
    HTTP_WORKFLOW_TIME_OPERATORS,
    HTTP_WORKFLOW_MAX_RUNS,
} = require("../../src/util");

/**
 * Load the workflow configuration (workflow + ordered steps + assertions + extractions)
 * for a monitor.
 * @param {number} monitorID ID of the workflow monitor
 * @returns {Promise<object|null>} Workflow config, or null when the monitor has no workflow
 */
async function getWorkflowForMonitor(monitorID) {
    const workflow = await R.findOne("http_workflow", " monitor_id = ? ", [monitorID]);
    if (!workflow) {
        return null;
    }

    const steps = await R.getAll(
        "SELECT * FROM http_workflow_step WHERE workflow_id = ? ORDER BY `order` ASC",
        [workflow.id]
    );

    const stepConfigs = [];
    for (const step of steps) {
        const assertions = await R.getAll(
            "SELECT * FROM http_workflow_assertion WHERE step_id = ?",
            [step.id]
        );
        const extractions = await R.getAll(
            "SELECT * FROM http_workflow_extraction WHERE step_id = ?",
            [step.id]
        );

        stepConfigs.push({
            id: step.id,
            order: step.order,
            name: step.name,
            method: step.method,
            url: step.url,
            headers: step.headers ? JSON.parse(step.headers) : {},
            queryParams: step.query_params ? JSON.parse(step.query_params) : {},
            body: step.body,
            timeout: Number(step.timeout),
            assertions: assertions.map((a) => ({
                id: a.id,
                type: a.type,
                path: a.path,
                operator: a.operator,
                expectedValue: a.expected_value,
            })),
            extractions: extractions.map((e) => ({
                id: e.id,
                path: e.path,
                variableName: e.variable_name,
            })),
        });
    }

    return {
        id: workflow.id,
        monitor_id: workflow.monitor_id,
        enabled: workflow.enabled === 1 || workflow.enabled === true,
        timeout: Number(workflow.timeout),
        steps: stepConfigs,
    };
}

/**
 * Validate a workflow payload from the frontend.
 * @param {object} workflow Workflow payload
 * @throws {Error} If the payload is invalid
 * @returns {void}
 */
function validateWorkflowPayload(workflow) {
    if (!Array.isArray(workflow.steps)) {
        throw new Error("Workflow steps must be an array.");
    }

    if (workflow.steps.length === 0) {
        throw new Error("A workflow requires at least one step.");
    }

    if (workflow.steps.length > 50) {
        throw new Error("A workflow cannot have more than 50 steps.");
    }

    for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];

        if (!step || typeof step !== "object") {
            throw new Error(`Step #${i + 1} is invalid.`);
        }

        if (!HTTP_WORKFLOW_METHODS.includes(step.method)) {
            throw new Error(`Step #${i + 1}: unsupported HTTP method "${step.method}".`);
        }

        if (!step.url || typeof step.url !== "string" || !step.url.trim()) {
            throw new Error(`Step #${i + 1}: URL is required.`);
        }

        if (step.headers !== undefined && step.headers !== null && typeof step.headers !== "object") {
            throw new Error(`Step #${i + 1}: headers must be an object.`);
        }

        if (step.queryParams !== undefined && step.queryParams !== null && typeof step.queryParams !== "object") {
            throw new Error(`Step #${i + 1}: query parameters must be an object.`);
        }

        if (step.body !== undefined && step.body !== null && typeof step.body !== "string") {
            throw new Error(`Step #${i + 1}: body must be a string.`);
        }

        const timeout = Number(step.timeout);
        if (!Number.isFinite(timeout) || timeout < 0) {
            throw new Error(`Step #${i + 1}: timeout must be a non-negative number of seconds.`);
        }

        if (!Array.isArray(step.assertions)) {
            throw new Error(`Step #${i + 1}: assertions must be an array.`);
        }

        for (const assertion of step.assertions) {
            if (!HTTP_WORKFLOW_ASSERTION_TYPES.includes(assertion.type)) {
                throw new Error(`Step #${i + 1}: unsupported assertion type "${assertion.type}".`);
            }

            if (assertion.type === "status") {
                if (!HTTP_WORKFLOW_STATUS_OPERATORS.includes(assertion.operator)) {
                    throw new Error(`Step #${i + 1}: unsupported status operator "${assertion.operator}".`);
                }
                if (!/^\d{3}$/.test(String(assertion.expectedValue ?? ""))) {
                    throw new Error(`Step #${i + 1}: status assertion requires a 3-digit status code.`);
                }
            } else if (assertion.type === "bodyContains") {
                if (typeof assertion.expectedValue !== "string" || !assertion.expectedValue) {
                    throw new Error(`Step #${i + 1}: bodyContains assertion requires expected text.`);
                }
            } else if (assertion.type === "jsonEquals") {
                if (!assertion.path) {
                    throw new Error(`Step #${i + 1}: jsonEquals assertion requires a JSON path.`);
                }
                if (assertion.expectedValue === undefined || assertion.expectedValue === null) {
                    throw new Error(`Step #${i + 1}: jsonEquals assertion requires an expected value.`);
                }
            } else if (assertion.type === "jsonExists") {
                if (!assertion.path) {
                    throw new Error(`Step #${i + 1}: jsonExists assertion requires a JSON path.`);
                }
            } else if (assertion.type === "responseTime") {
                if (!HTTP_WORKFLOW_TIME_OPERATORS.includes(assertion.operator)) {
                    throw new Error(`Step #${i + 1}: unsupported response time operator "${assertion.operator}".`);
                }
                const expected = Number(assertion.expectedValue);
                if (!Number.isFinite(expected) || expected < 0) {
                    throw new Error(`Step #${i + 1}: responseTime assertion requires a non-negative millisecond value.`);
                }
            }
        }

        if (!Array.isArray(step.extractions)) {
            throw new Error(`Step #${i + 1}: extractions must be an array.`);
        }

        for (const extraction of step.extractions) {
            if (!extraction.path) {
                throw new Error(`Step #${i + 1}: extraction requires a JSON path.`);
            }
            if (!extraction.variableName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(extraction.variableName)) {
                throw new Error(
                    `Step #${i + 1}: extraction variable name must start with a letter or underscore and contain only letters, digits and underscores.`
                );
            }
        }
    }
}

/**
 * Upsert the workflow of a monitor. Steps are replaced atomically on save.
 * @param {number} monitorID ID of the workflow monitor
 * @param {object} workflow Workflow payload from the frontend
 * @returns {Promise<void>} Resolves when the workflow is stored
 */
async function setWorkflowForMonitor(monitorID, workflow) {
    validateWorkflowPayload(workflow);

    let bean = await R.findOne("http_workflow", " monitor_id = ? ", [monitorID]);
    if (!bean) {
        bean = R.dispense("http_workflow");
        bean.monitor_id = monitorID;
    }

    bean.enabled = workflow.enabled === false ? 0 : 1;
    bean.timeout = Math.max(0, Number(workflow.timeout) || 0);
    await R.store(bean);

    // Replace steps (and their assertions/extractions) atomically
    await R.exec("DELETE FROM http_workflow_step WHERE workflow_id = ?", [bean.id]);

    for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];

        const stepBean = R.dispense("http_workflow_step");
        stepBean.workflow_id = bean.id;
        stepBean.order = i + 1;
        stepBean.name = step.name || `Step ${i + 1}`;
        stepBean.method = step.method;
        stepBean.url = step.url.trim();
        stepBean.headers = step.headers && Object.keys(step.headers).length > 0 ? JSON.stringify(step.headers) : null;
        stepBean.query_params =
            step.queryParams && Object.keys(step.queryParams).length > 0 ? JSON.stringify(step.queryParams) : null;
        stepBean.body = step.body || null;
        stepBean.timeout = Math.max(0, Number(step.timeout) || 0);
        await R.store(stepBean);

        for (const assertion of step.assertions) {
            const assertionBean = R.dispense("http_workflow_assertion");
            assertionBean.step_id = stepBean.id;
            assertionBean.type = assertion.type;
            assertionBean.path = assertion.path || null;
            assertionBean.operator = assertion.operator || null;
            assertionBean.expected_value = assertion.expectedValue !== undefined ? String(assertion.expectedValue) : null;
            await R.store(assertionBean);
        }

        for (const extraction of step.extractions) {
            const extractionBean = R.dispense("http_workflow_extraction");
            extractionBean.step_id = stepBean.id;
            extractionBean.path = extraction.path;
            extractionBean.variable_name = extraction.variableName;
            await R.store(extractionBean);
        }
    }
}

/**
 * Delete the workflow of a monitor (also cascades via FK).
 * @param {number} monitorID ID of the workflow monitor
 * @returns {Promise<void>} Resolves when the workflow is removed
 */
async function deleteWorkflowForMonitor(monitorID) {
    const workflow = await R.findOne("http_workflow", " monitor_id = ? ", [monitorID]);
    if (workflow) {
        await R.trash(workflow);
    }
}

/**
 * Create a workflow run and return its id.
 * @param {number} workflowID ID of the workflow this run belongs to
 * @returns {Promise<number>} ID of the created run
 */
async function createRun(workflowID) {
    const run = R.dispense("http_workflow_run");
    run.workflow_id = workflowID;
    run.started_at = dayjs.utc().format(SQL_DATETIME_FORMAT);
    run.status = WORKFLOW_STATUS_RUNNING;
    await R.store(run);
    return run.id;
}

/**
 * Record the result of a single workflow step.
 * @param {number} runID ID of the run the result belongs to
 * @param {number} stepID ID of the step the result belongs to
 * @param {number} status Step result status (success/failed/skipped)
 * @param {number|null} statusCode HTTP status code, if any
 * @param {number|null} duration Duration in ms, if measurable
 * @param {string|null} error Error message, if any
 * @returns {Promise<void>} Resolves when the result is stored
 */
async function addStepResult(runID, stepID, status, statusCode, duration, error) {
    const bean = R.dispense("http_workflow_step_result");
    bean.run_id = runID;
    bean.step_id = stepID;
    bean.status = status;
    bean.status_code = statusCode;
    bean.duration = duration;
    bean.error = error || null;
    await R.store(bean);
}

/**
 * Finish a workflow run.
 * @param {number} runID ID of the run to finish
 * @param {number} status Final run status (success/failed/timed out)
 * @param {number} duration Total duration in ms
 * @returns {Promise<void>} Resolves when the run is updated
 */
async function finishRun(runID, status, duration) {
    const run = await R.findOne("http_workflow_run", " id = ? ", [runID]);
    if (!run) {
        log.warn("http-workflow", `http_workflow_run #${runID} not found when finishing`);
        return;
    }

    run.status = status;
    run.finished_at = dayjs.utc().format(SQL_DATETIME_FORMAT);
    run.duration = Math.max(0, Math.round(duration));
    await R.store(run);
}

/**
 * Prune old runs of a workflow so only the most recent ones are kept.
 * Respects the user's data retention setting when it is stricter than the cap.
 * @param {number} workflowID ID of the workflow to prune
 * @param {number} keepDataPeriodDays Data retention period in days (null = unlimited)
 * @returns {Promise<void>} Resolves when pruning is done
 */
async function pruneOldRuns(workflowID, keepDataPeriodDays = null) {
    try {
        // Cap by number of runs
        await R.exec(
            `DELETE FROM http_workflow_run
             WHERE workflow_id = ? AND id NOT IN (
                 SELECT id FROM http_workflow_run WHERE workflow_id = ? ORDER BY id DESC LIMIT ?
             )`,
            [workflowID, workflowID, HTTP_WORKFLOW_MAX_RUNS]
        );

        // Respect the data retention period (if configured)
        if (Number.isFinite(keepDataPeriodDays) && keepDataPeriodDays >= 1) {
            const cutoff = dayjs().utc().subtract(keepDataPeriodDays, "day").format(SQL_DATETIME_FORMAT);
            await R.exec("DELETE FROM http_workflow_run WHERE workflow_id = ? AND started_at < ?", [
                workflowID,
                cutoff,
            ]);
        }
    } catch (e) {
        log.warn("http-workflow", `Failed to prune old workflow runs: ${e.message}`);
    }
}

/**
 * Get the latest finished workflow run with step results for a monitor.
 * @param {number} monitorID ID of the workflow monitor
 * @returns {Promise<object|null>} Latest run with step results, or null
 */
async function getLatestRunForMonitor(monitorID) {
    const workflow = await R.findOne("http_workflow", " monitor_id = ? ", [monitorID]);
    if (!workflow) {
        return null;
    }

    const run = await R.getRow(
        "SELECT * FROM http_workflow_run WHERE workflow_id = ? AND status != ? ORDER BY id DESC LIMIT 1",
        [workflow.id, WORKFLOW_STATUS_RUNNING]
    );

    if (!run) {
        return null;
    }

    const results = await R.getAll(
        `SELECT r.id, r.status, r.status_code, r.duration, r.error, s.name, s.method, s.url, s.order
         FROM http_workflow_step_result r
         JOIN http_workflow_step s ON s.id = r.step_id
         WHERE r.run_id = ?
         ORDER BY s.order ASC`,
        [run.id]
    );

    return {
        run_id: run.id,
        status: run.status,
        started_at: run.started_at,
        finished_at: run.finished_at,
        duration: run.duration,
        steps: results.map((r) => ({
            name: r.name,
            method: r.method,
            url: r.url,
            order: r.order,
            status: r.status,
            status_code: r.status_code,
            duration: r.duration,
            error: r.error,
        })),
    };
}

module.exports = {
    WORKFLOW_STATUS_RUNNING,
    WORKFLOW_STATUS_SUCCESS,
    WORKFLOW_STATUS_FAILED,
    WORKFLOW_STATUS_TIMED_OUT,
    WORKFLOW_STEP_STATUS_SUCCESS,
    WORKFLOW_STEP_STATUS_FAILED,
    WORKFLOW_STEP_STATUS_SKIPPED,
    getWorkflowForMonitor,
    validateWorkflowPayload,
    setWorkflowForMonitor,
    deleteWorkflowForMonitor,
    createRun,
    addStepResult,
    finishRun,
    pruneOldRuns,
    getLatestRunForMonitor,
};
