const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { R } = require("redbean-node");
const { UP, DOWN } = require("../../../src/util");
const { HttpWorkflowMonitorType } = require("../../../server/monitor-types/http-workflow");
const HttpWorkflow = require("../../../server/model/http-workflow");
const {
    interpolate,
    redact,
    buildBody,
    parseBody,
    evaluatePath,
    evaluateAssertions,
} = require("../../../server/monitor-types/http-workflow");

// Unique per process so a stale/crashed run can never lock out a fresh one.
const TEST_DB_PATH = path.join(__dirname, `../../../data/test-http-workflow-${process.pid}.db`);

/**
 * Set up an in-memory style SQLite database (file backed) with all tables + migrations.
 * @returns {Promise<object>} The knex instance
 */
async function setupDatabase() {
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    if (fs.existsSync(TEST_DB_PATH)) {
        fs.unlinkSync(TEST_DB_PATH);
    }

    const Dialect = require("knex/lib/dialects/sqlite3/index.js");
    Dialect.prototype._driver = () => require("@louislam/sqlite3");

    const knex = require("knex");
    const db = knex({
        client: Dialect,
        connection: {
            filename: TEST_DB_PATH,
        },
        useNullAsDefault: true,
    });

    R.setup(db);
    R.freeze(true);

    const { createTables } = require("../../../db/knex_init_db.js");
    await createTables();

    await R.knex.migrate.latest({
        directory: path.join(__dirname, "../../../db/knex_migrations"),
    });

    return db;
}

/**
 * Create a workflow monitor bean in the database.
 * @param {object} workflow Workflow payload
 * @returns {Promise<object>} Monitor bean
 */
async function createWorkflowMonitor(workflow) {
    const monitor = R.dispense("monitor");
    monitor.name = "Test Workflow";
    monitor.type = "http-workflow";
    monitor.user_id = 1;
    monitor.interval = 60;
    monitor.timeout = 10;
    await R.store(monitor);

    await HttpWorkflow.setWorkflowForMonitor(monitor.id, workflow);
    return monitor;
}

/**
 * Start a local HTTP server for the workflow tests.
 * @returns {Promise<{server: object, port: number, requests: Array<object>}>} Server + port + request log
 */
async function startTestServer() {
    const requests = [];

    const server = http.createServer((req, res) => {
        requests.push({
            method: req.method,
            url: req.url,
            authorization: req.headers["authorization"],
            body: null,
        });

        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
        });

        req.on("end", () => {
            if (requests.length > 0) {
                requests[requests.length - 1].body = body;
            }

            const send = (status, data) => {
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(typeof data === "string" ? data : JSON.stringify(data));
            };

            if (req.method === "POST" && req.url.startsWith("/api/login")) {
                send(200, { token: "secret-token-123", user_id: 42 });
            } else if (req.method === "GET" && req.url.startsWith("/api/profile")) {
                if (req.headers["authorization"] === "Bearer secret-token-123") {
                    send(200, { authenticated: true, name: "Alice" });
                } else {
                    send(401, { error: "unauthorized" });
                }
            } else if (req.method === "GET" && req.url.startsWith("/api/orders")) {
                send(200, { orders: [ 1, 2, 3 ] });
            } else if (req.method === "GET" && req.url.startsWith("/api/echo-token")) {
                const token = (req.headers["authorization"] || "Bearer ").replace("Bearer ", "");
                send(200, { token });
            } else if (req.method === "GET" && req.url.startsWith("/api/fail")) {
                send(500, { error: "boom" });
            } else if (req.method === "GET" && req.url.startsWith("/api/never")) {
                send(200, { ok: true });
            } else {
                send(404, { error: "not found" });
            }
        });
    });

    await new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    return {
        server,
        port: server.address().port,
        requests,
    };
}

describe("HTTP Workflow Monitor", () => {
    let db;
    let testServer;
    let baseURL;

    before(async () => {
        db = await setupDatabase();
        const started = await startTestServer();
        testServer = started;
        baseURL = `http://127.0.0.1:${started.port}`;
    });

    after(async () => {
        if (testServer) {
            testServer.server.close();
        }
        if (db) {
            await R.knex.destroy();
        }
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.unlinkSync(TEST_DB_PATH);
        }
    });

    test("check() runs a successful login flow with extraction and variable usage", async () => {
        const workflow = {
            enabled: true,
            timeout: 0,
            steps: [
                {
                    name: "Login",
                    method: "POST",
                    url: `${baseURL}/api/login`,
                    headers: { "Content-Type": "application/json" },
                    queryParams: {},
                    body: `{\n    "email": "user@example.com",\n    "password": "hunter2"\n}`,
                    timeout: 0,
                    assertions: [
                        {
                            type: "status",
                            path: null,
                            operator: "==",
                            expectedValue: "200",
                        },
                    ],
                    extractions: [
                        {
                            path: "$.token",
                            variableName: "access_token",
                        },
                    ],
                },
                {
                    name: "Profile",
                    method: "GET",
                    url: `${baseURL}/api/profile`,
                    headers: {
                        Authorization: "Bearer {{access_token}}",
                    },
                    queryParams: {},
                    body: "",
                    timeout: 0,
                    assertions: [
                        {
                            type: "status",
                            path: null,
                            operator: "==",
                            expectedValue: "200",
                        },
                        {
                            type: "jsonEquals",
                            path: "$.authenticated",
                            operator: null,
                            expectedValue: "true",
                        },
                    ],
                    extractions: [],
                },
                {
                    name: "Orders",
                    method: "GET",
                    url: `${baseURL}/api/orders`,
                    headers: {},
                    queryParams: {},
                    body: "",
                    timeout: 0,
                    assertions: [
                        {
                            type: "jsonExists",
                            path: "$.orders",
                            operator: null,
                            expectedValue: null,
                        },
                    ],
                    extractions: [],
                },
            ],
        };

        const monitor = await createWorkflowMonitor(workflow);
        const monitorType = new HttpWorkflowMonitorType();
        const heartbeat = {
            msg: "",
            status: DOWN,
        };

        await monitorType.check(monitor, heartbeat, {});

        assert.strictEqual(heartbeat.status, UP);
        assert.ok(heartbeat.msg.includes("Workflow passed"));
        assert.ok(heartbeat.ping > 0);

        // The profile request must have carried the extracted token.
        const profileRequest = testServer.requests.find((r) => r.url.startsWith("/api/profile"));
        assert.strictEqual(profileRequest.authorization, "Bearer secret-token-123");

        // The run and all step results must be recorded.
        const run = await R.getRow(
            "SELECT * FROM http_workflow_run WHERE workflow_id = ? ORDER BY id DESC LIMIT 1",
            [ (await R.getRow("SELECT id FROM http_workflow WHERE monitor_id = ?", [monitor.id])).id ]
        );
        assert.strictEqual(run.status, 1); // SUCCESS

        const results = await R.getAll(
            "SELECT status FROM http_workflow_step_result WHERE run_id = ? ORDER BY id ASC",
            [run.id]
        );
        assert.strictEqual(results.length, 3);
        for (const result of results) {
            assert.strictEqual(result.status, 0); // all success
        }
    });

    test("check() fails the workflow when a required step fails and skips remaining steps", async () => {
        const workflow = {
            enabled: true,
            timeout: 0,
            steps: [
                {
                    name: "OK",
                    method: "GET",
                    url: `${baseURL}/api/orders`,
                    headers: {},
                    queryParams: {},
                    body: "",
                    timeout: 0,
                    assertions: [],
                    extractions: [],
                },
                {
                    name: "Failing",
                    method: "GET",
                    url: `${baseURL}/api/fail`,
                    headers: {},
                    queryParams: {},
                    body: "",
                    timeout: 0,
                    assertions: [
                        {
                            type: "status",
                            path: null,
                            operator: "==",
                            expectedValue: "200",
                        },
                    ],
                    extractions: [],
                },
                {
                    name: "Never",
                    method: "GET",
                    url: `${baseURL}/api/never`,
                    headers: {},
                    queryParams: {},
                    body: "",
                    timeout: 0,
                    assertions: [],
                    extractions: [],
                },
            ],
        };

        const monitor = await createWorkflowMonitor(workflow);
        const monitorType = new HttpWorkflowMonitorType();
        const heartbeat = {
            msg: "",
            status: UP,
        };

        await assert.rejects(monitorType.check(monitor, heartbeat, {}), /Step 2 \(Failing\) failed/);
        assert.strictEqual(heartbeat.status, UP); // remains UP; monitor.js flips to DOWN on throw
        assert.ok(heartbeat.msg.includes("Expected status 200, received 500"));

        const run = await R.getRow(
            "SELECT * FROM http_workflow_run WHERE workflow_id = ? ORDER BY id DESC LIMIT 1",
            [ (await R.getRow("SELECT id FROM http_workflow WHERE monitor_id = ?", [monitor.id])).id ]
        );
        assert.strictEqual(run.status, 2); // FAILED

        const results = await R.getAll(
            "SELECT status FROM http_workflow_step_result WHERE run_id = ? ORDER BY id ASC",
            [run.id]
        );
        assert.strictEqual(results.length, 3);
        assert.strictEqual(results[0].status, 0); // success
        assert.strictEqual(results[1].status, 1); // failed
        assert.strictEqual(results[2].status, 2); // skipped
    });

    test("check() redacts extracted secrets from error messages and heartbeat msg", async () => {
        const workflow = {
            enabled: true,
            timeout: 0,
            steps: [
                {
                    name: "Login",
                    method: "POST",
                    url: `${baseURL}/api/login`,
                    headers: {},
                    queryParams: {},
                    body: "",
                    timeout: 0,
                    assertions: [],
                    extractions: [
                        {
                            path: "$.token",
                            variableName: "token",
                        },
                    ],
                },
                {
                    name: "Echo",
                    method: "GET",
                    url: `${baseURL}/api/echo-token`,
                    headers: {
                        Authorization: "Bearer {{token}}",
                    },
                    queryParams: {},
                    body: "",
                    timeout: 0,
                    assertions: [
                        {
                            type: "jsonEquals",
                            path: "$.token",
                            operator: null,
                            expectedValue: "wrong",
                        },
                    ],
                    extractions: [],
                },
            ],
        };

        const monitor = await createWorkflowMonitor(workflow);
        const monitorType = new HttpWorkflowMonitorType();
        const heartbeat = {
            msg: "",
            status: UP,
        };

        await assert.rejects(monitorType.check(monitor, heartbeat, {}));

        // The raw assertion error would contain the token, but it must be redacted.
        assert.ok(!heartbeat.msg.includes("secret-token-123"));
        assert.ok(heartbeat.msg.includes("***"));

        const workflowRow = await R.getRow("SELECT id FROM http_workflow WHERE monitor_id = ?", [monitor.id]);
        const run = await R.getRow(
            "SELECT * FROM http_workflow_run WHERE workflow_id = ? ORDER BY id DESC LIMIT 1",
            [workflowRow.id]
        );
        const failedResult = await R.getRow(
            "SELECT error FROM http_workflow_step_result WHERE run_id = ? AND status = 1 LIMIT 1",
            [run.id]
        );
        assert.ok(failedResult.error);
        assert.ok(!failedResult.error.includes("secret-token-123"));
        assert.ok(failedResult.error.includes("***"));
    });

    test("interpolate() replaces known variables and leaves unknown ones untouched", () => {
        assert.strictEqual(interpolate("Bearer {{access_token}}", { access_token: "abc" }), "Bearer abc");
        assert.strictEqual(interpolate("{{ missing }}", {}), "{{ missing }}");
        assert.strictEqual(interpolate("{{a}}/{{ b }}", { a: 1, b: 2 }), "1/2");
        assert.strictEqual(interpolate(null, {}), null);
    });

    test("redact() replaces all secret values with ***", () => {
        assert.strictEqual(redact("token abc found", [ "abc" ]), "token *** found");
        assert.strictEqual(redact("abc abc abc", [ "abc" ]), "*** *** ***");
        assert.strictEqual(redact("no secrets", [ "abc" ]), "no secrets");
        assert.strictEqual(redact("", [ "abc" ]), "");
    });

    test("buildBody() parses JSON bodies and falls back to raw text", () => {
        const variables = { token: "abc" };
        const jsonBody = buildBody(`{\n    "auth": "{{token}}"\n}`, variables);
        assert.deepStrictEqual(jsonBody.data, { auth: "abc" });
        assert.strictEqual(jsonBody.contentType, "application/json");

        const rawBody = buildBody("key={{token}}", variables);
        assert.strictEqual(rawBody.data, "key=abc");
        assert.strictEqual(rawBody.contentType, null);

        const emptyBody = buildBody("", variables);
        assert.strictEqual(emptyBody.data, null);
    });

    test("parseBody() parses JSON strings", () => {
        assert.deepStrictEqual(parseBody('{"a": 1}'), { a: 1 });
        assert.strictEqual(parseBody("plain text"), "plain text");
        assert.deepStrictEqual(parseBody({ a: 1 }), { a: 1 });
        assert.strictEqual(parseBody(null), null);
    });

    test("evaluatePath() evaluates jsonata expressions", async () => {
        const data = { user: { id: 42 }, tags: [ "a", "b" ] };
        assert.strictEqual(await evaluatePath("$.user.id", data), 42);
        assert.strictEqual(await evaluatePath("$.tags[0]", data), "a");
        // Missing paths evaluate to undefined (jsonExists relies on this);
        // syntax errors must throw.
        assert.strictEqual(await evaluatePath("$.missing", data), undefined);
        await assert.rejects(evaluatePath("$.user[", data), /could not be evaluated/);
    });

    test("evaluateAssertions() supports all assertion types", async () => {
        const response = {
            statusCode: 200,
            duration: 150,
            data: { authenticated: true, token: "abc" },
        };

        assert.strictEqual(
            await evaluateAssertions(
                [ { type: "status", operator: "==", expectedValue: "200" } ],
                response
            ),
            null
        );
        assert.ok(
            await evaluateAssertions(
                [ { type: "status", operator: "!=", expectedValue: "500" } ],
                response
            ) === null
        );
        assert.ok(
            (await evaluateAssertions(
                [ { type: "status", operator: "==", expectedValue: "201" } ],
                response
            )).includes("Expected status 201, received 200")
        );
        assert.strictEqual(
            await evaluateAssertions(
                [ { type: "bodyContains", expectedValue: "authenticated" } ],
                response
            ),
            null
        );
        assert.ok(
            (await evaluateAssertions(
                [ { type: "bodyContains", expectedValue: "missing" } ],
                response
            )).includes("does not contain")
        );
        assert.strictEqual(
            await evaluateAssertions(
                [ { type: "jsonEquals", path: "$.authenticated", expectedValue: "true" } ],
                response
            ),
            null
        );
        assert.strictEqual(
            await evaluateAssertions(
                [ { type: "jsonExists", path: "$.token" } ],
                response
            ),
            null
        );
        assert.ok(
            (await evaluateAssertions(
                [ { type: "jsonExists", path: "$.nope" } ],
                response
            )).includes("does not exist")
        );
        assert.strictEqual(
            await evaluateAssertions(
                [ { type: "responseTime", operator: "<", expectedValue: "200" } ],
                response
            ),
            null
        );
        assert.ok(
            (await evaluateAssertions(
                [ { type: "responseTime", operator: "<", expectedValue: "100" } ],
                response
            )).includes("does not satisfy")
        );

        // Without a status assertion, non-2xx fails by default.
        const badResponse = { statusCode: 500, duration: 10, data: {} };
        assert.ok(
            (await evaluateAssertions([], badResponse)).includes("Expected a 2xx status")
        );
    });
});