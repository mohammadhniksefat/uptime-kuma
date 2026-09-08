exports.up = function (knex) {
    return knex.schema
        .createTable("http_workflow", (table) => {
            table.increments("id");
            table
                .integer("monitor_id")
                .unsigned()
                .notNullable()
                .unique()
                .references("id")
                .inTable("monitor")
                .onDelete("CASCADE");
            table.boolean("enabled").notNullable().defaultTo(true);
            table
                .integer("timeout")
                .unsigned()
                .notNullable()
                .defaultTo(0);
        })
        .createTable("http_workflow_step", (table) => {
            table.increments("id");
            table
                .integer("workflow_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("http_workflow")
                .onDelete("CASCADE");
            table.integer("order").notNullable();
            table.string("name").notNullable().defaultTo("");
            table.string("method", 10).notNullable().defaultTo("GET");
            table.text("url").notNullable();
            table.text("headers").nullable();
            table.text("query_params").nullable();
            table.text("body").nullable();
            table
                .integer("timeout")
                .unsigned()
                .notNullable()
                .defaultTo(0);
        })
        .createTable("http_workflow_assertion", (table) => {
            table.increments("id");
            table
                .integer("step_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("http_workflow_step")
                .onDelete("CASCADE");
            table.string("type", 30).notNullable();
            table.string("path").nullable();
            table.string("operator", 20).nullable();
            table.text("expected_value").nullable();
        })
        .createTable("http_workflow_extraction", (table) => {
            table.increments("id");
            table
                .integer("step_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("http_workflow_step")
                .onDelete("CASCADE");
            table.string("path").notNullable();
            table.string("variable_name", 100).notNullable();
        })
        .createTable("http_workflow_run", (table) => {
            table.increments("id");
            table
                .integer("workflow_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("http_workflow")
                .onDelete("CASCADE");
            table.datetime("started_at").notNullable();
            table.datetime("finished_at").nullable();
            table
                .integer("status")
                .unsigned()
                .notNullable()
                .defaultTo(0);
            table
                .integer("duration")
                .unsigned()
                .nullable();
        })
        .createTable("http_workflow_step_result", (table) => {
            table.increments("id");
            table
                .integer("run_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("http_workflow_run")
                .onDelete("CASCADE");
            table
                .integer("step_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("http_workflow_step")
                .onDelete("CASCADE");
            table
                .integer("status")
                .unsigned()
                .notNullable();
            table
                .integer("status_code")
                .unsigned()
                .nullable();
            table
                .integer("duration")
                .unsigned()
                .nullable();
            table.text("error").nullable();
        });
};

exports.down = function (knex) {
    return knex.schema
        .dropTable("http_workflow_step_result")
        .dropTable("http_workflow_run")
        .dropTable("http_workflow_extraction")
        .dropTable("http_workflow_assertion")
        .dropTable("http_workflow_step")
        .dropTable("http_workflow");
};
