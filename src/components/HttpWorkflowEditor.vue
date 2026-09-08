<template>
    <div class="http-workflow-editor">
        <div class="d-flex justify-content-between align-items-center mb-2">
            <label class="form-label mb-0">{{ $t("Workflow Steps") }}</label>
            <button
                type="button"
                class="btn btn-sm btn-outline-primary"
                :aria-label="$t('workflowAddStep')"
                @click="addStep"
            >
                <font-awesome-icon icon="plus" class="me-1" />{{ $t("workflowAddStep") }}
            </button>
        </div>

        <p class="form-text">{{ $t("workflowStepsDescription") }}</p>

        <div v-if="model.steps.length === 0" class="alert alert-secondary">
            {{ $t("workflowNoSteps") }}
        </div>

        <div
            v-for="(step, index) in model.steps"
            :key="index"
            class="workflow-step shadow-box mb-3"
        >
            <div class="step-header d-flex justify-content-between align-items-center p-2 border-bottom">
                <span class="fw-bold">
                    {{ index + 1 }}. {{ step.name || $t("workflowStep") }}
                </span>
                <span>
                    <button
                        type="button"
                        class="btn btn-sm btn-outline-secondary me-1"
                        :disabled="index === 0"
                        :aria-label="$t('Move Up')"
                        @click="moveStep(index, -1)"
                    >
                        ▲
                    </button>
                    <button
                        type="button"
                        class="btn btn-sm btn-outline-secondary me-1"
                        :disabled="index === model.steps.length - 1"
                        :aria-label="$t('Move Down')"
                        @click="moveStep(index, 1)"
                    >
                        ▼
                    </button>
                    <button
                        type="button"
                        class="btn btn-sm btn-outline-danger"
                        :aria-label="$t('Delete')"
                        @click="removeStep(index)"
                    >
                        ✕
                    </button>
                </span>
            </div>

            <div class="p-2">
                <!-- Step name + method + timeout -->
                <div class="row g-2 mb-2">
                    <div class="col-md-5">
                        <input
                            v-model="step.name"
                            type="text"
                            class="form-control"
                            :placeholder="$t('workflowStepName')"
                        />
                    </div>
                    <div class="col-md-3">
                        <select v-model="step.method" class="form-select">
                            <option v-for="method in methods" :key="method" :value="method">
                                {{ method }}
                            </option>
                        </select>
                    </div>
                    <div class="col-md-4">
                        <div class="input-group">
                            <input
                                v-model.number="step.timeout"
                                type="number"
                                min="0"
                                step="0.1"
                                class="form-control"
                                :placeholder="$t('workflowStepTimeout')"
                            />
                            <span class="input-group-text">s</span>
                        </div>
                        <div class="form-text">{{ $t("workflowStepTimeoutDescription") }}</div>
                    </div>
                </div>

                <!-- URL -->
                <div class="mb-2">
                    <input
                        v-model="step.url"
                        type="text"
                        class="form-control"
                        :placeholder="$t('URL')"
                    />
                </div>

                <!-- Headers -->
                <div class="mb-2">
                    <label class="form-label small mb-1">{{ $t("Headers") }}</label>
                    <textarea
                        v-model="step.headersText"
                        class="form-control font-monospace"
                        rows="2"
                        :placeholder="headersPlaceholder"
                    ></textarea>
                </div>

                <!-- Query params -->
                <div class="mb-2">
                    <label class="form-label small mb-1">{{ $t("workflowQueryParams") }}</label>
                    <textarea
                        v-model="step.queryParamsText"
                        class="form-control font-monospace"
                        rows="2"
                        :placeholder="headersPlaceholder"
                    ></textarea>
                </div>

                <!-- Body -->
                <div v-if="hasBody(step.method)" class="mb-2">
                    <label class="form-label small mb-1">{{ $t("Body") }}</label>
                    <textarea
                        v-model="step.body"
                        class="form-control font-monospace"
                        rows="3"
                        :placeholder="bodyPlaceholder"
                    ></textarea>
                </div>

                <!-- Variables hint -->
                <div class="form-text mb-2">{{ $t("workflowVariableHint") }}</div>

                <!-- Extractions -->
                <div class="mb-2">
                    <label class="form-label small mb-1">{{ $t("workflowExtract") }}</label>
                    <div
                        v-for="(extraction, eIndex) in step.extractions"
                        :key="eIndex"
                        class="row g-2 mb-1"
                    >
                        <div class="col-5">
                            <input
                                v-model="extraction.path"
                                type="text"
                                class="form-control font-monospace"
                                placeholder="$.token"
                            />
                        </div>
                        <div class="col-5">
                            <input
                                v-model="extraction.variableName"
                                type="text"
                                class="form-control font-monospace"
                                :placeholder="$t('workflowStoreAs')"
                            />
                        </div>
                        <div class="col-2">
                            <button
                                type="button"
                                class="btn btn-sm btn-outline-danger w-100"
                                :aria-label="$t('Delete')"
                                @click="removeExtraction(step, eIndex)"
                            >
                                ✕
                            </button>
                        </div>
                    </div>
                    <button
                        type="button"
                        class="btn btn-sm btn-outline-secondary"
                        @click="addExtraction(step)"
                    >
                        <font-awesome-icon icon="plus" class="me-1" />{{ $t("workflowAddExtraction") }}
                    </button>
                </div>

                <!-- Assertions -->
                <div>
                    <label class="form-label small mb-1">{{ $t("workflowAssertions") }}</label>
                    <div
                        v-for="(assertion, aIndex) in step.assertions"
                        :key="aIndex"
                        class="row g-2 mb-1"
                    >
                        <div class="col-3">
                            <select v-model="assertion.type" class="form-select form-select-sm">
                                <option value="status">{{ $t("workflowAssertionStatus") }}</option>
                                <option value="bodyContains">{{ $t("workflowAssertionBodyContains") }}</option>
                                <option value="jsonEquals">{{ $t("workflowAssertionJsonEquals") }}</option>
                                <option value="jsonExists">{{ $t("workflowAssertionJsonExists") }}</option>
                                <option value="responseTime">{{ $t("workflowAssertionResponseTime") }}</option>
                            </select>
                        </div>
                        <div class="col-3">
                            <input
                                v-if="assertion.type === 'jsonEquals' || assertion.type === 'jsonExists'"
                                v-model="assertion.path"
                                type="text"
                                class="form-control form-control-sm font-monospace"
                                placeholder="$.user.id"
                            />
                            <select
                                v-else-if="assertion.type === 'status' || assertion.type === 'responseTime'"
                                v-model="assertion.operator"
                                class="form-select form-select-sm"
                            >
                                <option v-if="assertion.type === 'status'" value="==">==</option>
                                <option v-if="assertion.type === 'status'" value="!=">!=</option>
                                <option v-if="assertion.type === 'responseTime'" value="<">&lt;</option>
                                <option v-if="assertion.type === 'responseTime'" value="<=">&lt;=</option>
                                <option v-if="assertion.type === 'responseTime'" value=">">&gt;</option>
                                <option v-if="assertion.type === 'responseTime'" value=">=">&gt;=</option>
                            </select>
                        </div>
                        <div class="col-5">
                            <input
                                v-if="assertion.type !== 'jsonExists'"
                                v-model="assertion.expectedValue"
                                type="text"
                                class="form-control form-control-sm font-monospace"
                                :placeholder="$t('workflowExpectedValue')"
                            />
                            <span v-else class="form-text mb-0">-</span>
                        </div>
                        <div class="col-1">
                            <button
                                type="button"
                                class="btn btn-sm btn-outline-danger w-100"
                                :aria-label="$t('Delete')"
                                @click="removeAssertion(step, aIndex)"
                            >
                                ✕
                            </button>
                        </div>
                    </div>
                    <button
                        type="button"
                        class="btn btn-sm btn-outline-secondary"
                        @click="addAssertion(step)"
                    >
                        <font-awesome-icon icon="plus" class="me-1" />{{ $t("workflowAddAssertion") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: "HttpWorkflowEditor",

    props: {
        /**
         * The workflow configuration object { enabled, timeout, steps }
         */
        modelValue: {
            type: Object,
            required: true,
        },
    },

    emits: [ "update:modelValue" ],

    data() {
        return {
            methods: [ "GET", "POST", "PUT", "PATCH", "DELETE" ],
        };
    },

    computed: {
        model: {
            get() {
                return this.modelValue;
            },
            set(value) {
                this.$emit("update:modelValue", value);
            },
        },

        headersPlaceholder() {
            return this.$t("Example:", [
                `{\n    "HeaderName": "HeaderValue"\n}`,
            ]);
        },

        bodyPlaceholder() {
            return this.$t("Example:", [
                `{\n    "key": "value"\n}`,
            ]);
        },
    },

    methods: {
        /**
         * Whether the given HTTP method usually carries a body
         * @param {string} method HTTP method
         * @returns {boolean} True when a body is expected
         */
        hasBody(method) {
            return [ "POST", "PUT", "PATCH", "DELETE" ].includes(method);
        },

        /**
         * Add a new empty step
         * @returns {void}
         */
        addStep() {
            const workflow = { ...this.model, steps: [...this.model.steps, this.newStep()] };
            this.$emit("update:modelValue", workflow);
        },

        /**
         * Remove a step by index
         * @param {number} index Index of the step to remove
         * @returns {void}
         */
        removeStep(index) {
            const steps = [...this.model.steps];
            steps.splice(index, 1);
            this.$emit("update:modelValue", { ...this.model, steps });
        },

        /**
         * Move a step up or down
         * @param {number} index Index of the step to move
         * @param {number} direction -1 to move up, 1 to move down
         * @returns {void}
         */
        moveStep(index, direction) {
            const steps = [...this.model.steps];
            const target = index + direction;
            if (target < 0 || target >= steps.length) {
                return;
            }
            const [step] = steps.splice(index, 1);
            steps.splice(target, 0, step);
            this.$emit("update:modelValue", { ...this.model, steps });
        },

        /**
         * Add an empty extraction to a step
         * @param {object} step Step to modify
         * @returns {void}
         */
        addExtraction(step) {
            step.extractions.push({
                path: "",
                variableName: "",
            });
        },

        /**
         * Remove an extraction from a step
         * @param {object} step Step to modify
         * @param {number} index Index of the extraction to remove
         * @returns {void}
         */
        removeExtraction(step, index) {
            step.extractions.splice(index, 1);
        },

        /**
         * Add an empty assertion to a step
         * @param {object} step Step to modify
         * @returns {void}
         */
        addAssertion(step) {
            step.assertions.push({
                type: "status",
                path: null,
                operator: "==",
                expectedValue: "200",
            });
        },

        /**
         * Remove an assertion from a step
         * @param {object} step Step to modify
         * @param {number} index Index of the assertion to remove
         * @returns {void}
         */
        removeAssertion(step, index) {
            step.assertions.splice(index, 1);
        },

        /**
         * Create a new empty step object
         * @returns {object} New step
         */
        newStep() {
            return {
                name: "",
                method: "GET",
                url: "https://",
                headersText: "",
                queryParamsText: "",
                body: "",
                timeout: 0,
                assertions: [],
                extractions: [],
            };
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.workflow-step {
    border: 1px solid $dark-border-color;
    border-radius: 8px;
}

.step-header {
    background-color: rgba(0, 0, 0, 0.03);
}

.dark .step-header {
    background-color: rgba(255, 255, 255, 0.05);
}
</style>
