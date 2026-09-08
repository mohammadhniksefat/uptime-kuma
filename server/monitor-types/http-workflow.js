const { MonitorType } = require("./monitor-type");
const axios = require("axios");
const jsonata = require("jsonata");
const { log, UP, WORKFLOW_STATUS_SUCCESS, WORKFLOW_STATUS_FAILED, WORKFLOW_STATUS_TIMED_OUT } = require("../../src/util");
const { axiosAbortSignal } = require("../util-server");
const HttpWorkflow = require("../model/http-workflow");

/**
 * Replace {{variable}} placeholders in a string with values from the variable store.
 * Unknown variables are left untouched.
 * @param {string} template Template string
 * @param {object} variables Variable store
 * @returns {string} Interpolated string
 */
function interpolate(template, variables) {
    if (typeof template !== "string") {
        return template;
    }

    return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name) => {
        if (name in variables) {
            return String(variables[name]);
        }
        return match;
    });
}

/**
 * Interpolate all string values (and keys) of a nested object.
 * @param {object} obj Object to interpolate
 * @param {object} variables Variable store
 * @returns {object} New object with interpolated values
 */
function interpolateObject(obj, variables) {
    if (!obj) {
        return obj;
    }

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        const newKey = interpolate(key, variables);
        if (typeof value === "string") {
            result[newKey] = interpolate(value, variables);
        } else if (Array.isArray(value)) {
            result[newKey] = value.map((item) =>
                typeof item === "string" ? interpolate(item, variables) : item
            );
        } else if (value && typeof value === "object") {
            result[newKey] = interpolateObject(value, variables);
        } else {
            result[newKey] = value;
        }
    }
    return result;
}

/**
 * Redact all secret values from a string.
 * @param {string} text Text to redact
 * @param {string[]} secrets Secret values to hide
 * @returns {string} Redacted text
 */
function redact(text, secrets) {
    if (!text) {
        return text;
    }

    let result = String(text);
    for (const secret of secrets) {
        if (secret && typeof secret === "string" && secret.length > 0) {
            result = result.split(secret).join("***");
        }
    }
    return result;
}

/**
 * Evaluate a jsonata expression against response data.
 * @param {string} path Jsonata expression
 * @param {any} data Response data (already parsed JSON or raw string)
 * @returns {Promise<any>} Evaluation result
 */
async function evaluatePath(path, data) {
    try {
        return await jsonata(path).evaluate(data);
    } catch (e) {
        throw new Error(`JSON path "${path}" could not be evaluated: ${e.message}`);
    }
}

/**
 * Parse response body into a JSON value when possible.
 * @param {any} data Response data
 * @returns {any} Parsed JSON value
 */
function parseBody(data) {
    if (data === null || data === undefined) {
        return null;
    }

    if (typeof data === "object") {
        return data;
    }

    if (typeof data === "string") {
        try {
            return JSON.parse(data);
        } catch (_) {
            return data;
        }
    }

    return data;
}

/**
 * Build the request body value + content type for a step.
 * @param {string} body Body template
 * @param {object} variables Variable store
 * @returns {{data: any|null, contentType: string|null}} Request body data
 */
function buildBody(body, variables) {
    if (!body || typeof body !== "string" || !body.trim()) {
        return {
            data: null,
            contentType: null,
        };
    }

    const interpolated = interpolate(body, variables);

    try {
        return {
            data: JSON.parse(interpolated),
            contentType: "application/json",
        };
    } catch (_) {
        return {
            data: interpolated,
            contentType: null,
        };
    }
}

/**
 * Run a single workflow step.
 * @param {object} step Step configuration
 * @param {object} variables Variable store
 * @param {number} timeoutMs Per-step timeout in ms
 * @returns {Promise<{statusCode: number, duration: number, data: any}>} Step result
 * @throws {Error} When the request itself fails (network error, timeout)
 */
async function runStep(step, variables, timeoutMs) {
    const startTime = Date.now();

    const url = interpolate(step.url, variables);
    const headers = interpolateObject(step.headers || {}, variables);
    const queryParams = interpolateObject(step.queryParams || {}, variables);
    const { data: bodyData, contentType } = buildBody(step.body, variables);

    // Do not log interpolated URL/headers/body: they may contain secrets.
    log.debug("http-workflow", `[${step.name}] ${step.method} ${redact(url, Object.values(variables))}`);

    const options = {
        url,
        method: step.method.toLowerCase(),
        timeout: Math.max(1, Math.round(timeoutMs)),
        signal: axiosAbortSignal(Math.max(1000, Math.round(timeoutMs) + 1000)),
        maxRedirects: 10,
        validateStatus: () => true,
        headers: {
            Accept: "application/json, text/plain, */*",
            ...headers,
        },
        ...(queryParams && Object.keys(queryParams).length > 0 ? { params: queryParams } : {}),
    };

    if (bodyData !== null) {
        options.data = bodyData;
        if (contentType && !headers["Content-Type"] && !headers["content-type"]) {
            options.headers["Content-Type"] = contentType;
        }
    }

    let response;
    try {
        response = await axios.request(options);
    } catch (e) {
        if (e?.name === "CanceledError" || e?.code === "ECONNABORTED" || String(e?.message).includes("timeout")) {
            throw new Error(`Request timed out after ${Math.round(timeoutMs)}ms`);
        }
        throw new Error(`Request failed: ${redact(e.message, Object.values(variables))}`);
    }

    return {
        statusCode: response.status,
        duration: Date.now() - startTime,
        data: response.data,
    };
}

/**
 * Evaluate all assertions of a step.
 * @param {object[]} assertions Assertion configurations
 * @param {{statusCode: number, duration: number, data: any}} response Step response
 * @returns {Promise<string|null>} Error message when an assertion fails, null when all pass
 */
async function evaluateAssertions(assertions, response) {
    const hasStatusAssertion = assertions.some((a) => a.type === "status");

    for (const assertion of assertions) {
        if (assertion.type === "status") {
            const expected = Number(assertion.expectedValue);
            const passed = assertion.operator === "!="
                ? response.statusCode !== expected
                : response.statusCode === expected;

            if (!passed) {
                return `Expected status ${assertion.operator === "!=" ? "not " : ""}${expected}, received ${response.statusCode}.`;
            }
        } else if (assertion.type === "bodyContains") {
            const body = typeof response.data === "string"
                ? response.data
                : (response.data !== undefined && response.data !== null ? JSON.stringify(response.data) : "");
            if (!body.includes(assertion.expectedValue)) {
                return `Response body does not contain "${assertion.expectedValue}".`;
            }
        } else if (assertion.type === "jsonEquals") {
            const value = await evaluatePath(assertion.path, parseBody(response.data));
            if (String(value) !== String(assertion.expectedValue)) {
                return `JSON field ${assertion.path} does not equal "${assertion.expectedValue}" (got "${value}").`;
            }
        } else if (assertion.type === "jsonExists") {
            const value = await evaluatePath(assertion.path, parseBody(response.data));
            if (value === null || value === undefined) {
                return `JSON field ${assertion.path} does not exist.`;
            }
        } else if (assertion.type === "responseTime") {
            const expected = Number(assertion.expectedValue);
            let passed;
            switch (assertion.operator) {
                case "<":
                    passed = response.duration < expected;
                    break;
                case "<=":
                    passed = response.duration <= expected;
                    break;
                case ">":
                    passed = response.duration > expected;
                    break;
                case ">=":
                    passed = response.duration >= expected;
                    break;
                default:
                    passed = false;
            }
            if (!passed) {
                return `Response time ${response.duration}ms does not satisfy ${assertion.operator} ${expected}ms.`;
            }
        }
    }

    // Without an explicit status assertion, require a 2xx status by default.
    if (!hasStatusAssertion && (response.statusCode < 200 || response.statusCode >= 300)) {
        return `Expected a 2xx status, received ${response.statusCode}.`;
    }

    return null;
}

/**
 * Run all extractions of a step and store the values in the variable store.
 * Every extracted value is treated as a secret.
 * @param {object[]} extractions Extraction configurations
 * @param {any} data Response data
 * @param {object} variables Variable store (mutated)
 * @returns {Promise<void>} Resolves when all extractions are stored
 */
async function runExtractions(extractions, data, variables) {
    const parsed = parseBody(data);

    for (const extraction of extractions) {
        const value = await evaluatePath(extraction.path, parsed);
        if (value === null || value === undefined) {
            throw new Error(`Could not extract "${extraction.variableName}" from ${extraction.path}: value is empty.`);
        }
        variables[extraction.variableName] = value;
    }
}

class HttpWorkflowMonitorType extends MonitorType {
    name = "http-workflow";

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const workflow = await HttpWorkflow.getWorkflowForMonitor(monitor.id);

        if (!workflow) {
            throw new Error("No workflow is configured for this monitor.");
        }

        if (!workflow.enabled) {
            throw new Error("This workflow is disabled.");
        }

        // Global timeout: workflow timeout, else monitor timeout, else 10s default.
        let globalTimeoutSec = Number(workflow.timeout);
        if (!globalTimeoutSec || globalTimeoutSec <= 0) {
            globalTimeoutSec = Number(monitor.timeout);
        }
        if (!globalTimeoutSec || globalTimeoutSec <= 0 || globalTimeoutSec > 300) {
            globalTimeoutSec = 10;
        }

        const startTime = Date.now();
        const deadline = startTime + globalTimeoutSec * 1000;

        const runID = await HttpWorkflow.createRun(workflow.id);

        const variables = {};
        const secrets = [];

        let runStatus = WORKFLOW_STATUS_SUCCESS;
        let failureMessage = null;

        try {
            for (let i = 0; i < workflow.steps.length; i++) {
                const step = workflow.steps[i];

                const remainingMs = deadline - Date.now();
                if (remainingMs <= 0) {
                    // Global timeout: mark remaining steps as skipped.
                    for (let j = i; j < workflow.steps.length; j++) {
                        await HttpWorkflow.addStepResult(
                            runID,
                            workflow.steps[j].id,
                            HttpWorkflow.WORKFLOW_STEP_STATUS_SKIPPED,
                            null,
                            null,
                            null
                        );
                    }
                    runStatus = WORKFLOW_STATUS_TIMED_OUT;
                    failureMessage = `Workflow timed out after ${globalTimeoutSec}s.`;
                    break;
                }

                const stepTimeoutSec = Number(step.timeout);
                const stepTimeoutMs = stepTimeoutSec > 0
                    ? Math.min(stepTimeoutSec * 1000, remainingMs)
                    : remainingMs;

                let stepFailed = false;
                let stepError = null;

                try {
                    const response = await runStep(step, variables, stepTimeoutMs);

                    const assertionError = await evaluateAssertions(step.assertions, response);
                    if (assertionError) {
                        stepFailed = true;
                        stepError = assertionError;
                        await HttpWorkflow.addStepResult(
                            runID,
                            step.id,
                            HttpWorkflow.WORKFLOW_STEP_STATUS_FAILED,
                            response.statusCode,
                            response.duration,
                            redact(assertionError, secrets)
                        );
                    } else {
                        try {
                            await runExtractions(step.extractions, response.data, variables);
                        } catch (e) {
                            stepFailed = true;
                            stepError = e.message;
                            await HttpWorkflow.addStepResult(
                                runID,
                                step.id,
                                HttpWorkflow.WORKFLOW_STEP_STATUS_FAILED,
                                response.statusCode,
                                response.duration,
                                redact(e.message, secrets)
                            );
                        }
                    }

                    if (!stepFailed) {
                        // Extracted values are secrets: keep them for redaction.
                        for (const extraction of step.extractions) {
                            const value = variables[extraction.variableName];
                            if (value !== undefined && value !== null) {
                                secrets.push(String(value));
                            }
                        }

                        await HttpWorkflow.addStepResult(
                            runID,
                            step.id,
                            HttpWorkflow.WORKFLOW_STEP_STATUS_SUCCESS,
                            response.statusCode,
                            response.duration,
                            null
                        );
                    }
                } catch (e) {
                    stepFailed = true;
                    stepError = e.message;
                    await HttpWorkflow.addStepResult(
                        runID,
                        step.id,
                        HttpWorkflow.WORKFLOW_STEP_STATUS_FAILED,
                        null,
                        Date.now() - startTime,
                        redact(e.message, secrets)
                    );
                }

                if (stepFailed) {
                    // Mark remaining steps as skipped.
                    for (let j = i + 1; j < workflow.steps.length; j++) {
                        await HttpWorkflow.addStepResult(
                            runID,
                            workflow.steps[j].id,
                            HttpWorkflow.WORKFLOW_STEP_STATUS_SKIPPED,
                            null,
                            null,
                            null
                        );
                    }
                    runStatus = WORKFLOW_STATUS_FAILED;
                    failureMessage = `Step ${i + 1} (${step.name}) failed: ${redact(stepError, secrets)}`;
                    break;
                }
            }

            const totalDuration = Date.now() - startTime;
            await HttpWorkflow.finishRun(runID, runStatus, totalDuration);

            // Keep the run table small.
            await HttpWorkflow.pruneOldRuns(workflow.id);

            if (runStatus === WORKFLOW_STATUS_SUCCESS) {
                heartbeat.status = UP;
                heartbeat.msg = `Workflow passed (${workflow.steps.length} step${workflow.steps.length === 1 ? "" : "s"}, ${totalDuration}ms)`;
                heartbeat.ping = totalDuration;
                return;
            }

            heartbeat.msg = failureMessage;
            heartbeat.ping = totalDuration;
            throw new Error(failureMessage);
        } catch (e) {
            // If the failure happened outside of step execution (e.g. DB error while recording),
            // finish the run as failed so we do not leave it RUNNING forever.
            try {
                await HttpWorkflow.finishRun(runID, WORKFLOW_STATUS_FAILED, Date.now() - startTime);
                await HttpWorkflow.pruneOldRuns(workflow.id);
            } catch (_) {
                // Ignore secondary failures.
            }
            throw e;
        }
    }
}

module.exports = {
    HttpWorkflowMonitorType,
    interpolate,
    interpolateObject,
    redact,
    buildBody,
    parseBody,
    evaluatePath,
    evaluateAssertions,
    runExtractions,
};