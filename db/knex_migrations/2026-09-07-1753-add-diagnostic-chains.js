exports.up = function (knex) {
  return knex.schema
    .createTable("diagnostic_chain", (table) => {
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
    .createTable("diagnostic_item", (table) => {
      table.increments("id");
      table
        .integer("chain_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("diagnostic_chain")
        .onDelete("CASCADE");
      table
        .integer("monitor_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("monitor")
        .onDelete("CASCADE");
      table.integer("order").notNullable();
    })
    .createTable("diagnostic_run", (table) => {
      table.increments("id");
      table
        .integer("chain_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("diagnostic_chain")
        .onDelete("CASCADE");
      table.datetime("started_at").notNullable();
      table.datetime("finished_at").nullable();
      table
        .integer("status")
        .unsigned()
        .notNullable()
        .defaultTo(0);
    })
    .createTable("diagnostic_result", (table) => {
      table.increments("id");
      table
        .integer("run_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("diagnostic_run")
        .onDelete("CASCADE");
      table
        .integer("monitor_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("monitor")
        .onDelete("CASCADE");
      table
        .integer("status")
        .unsigned()
        .notNullable();
      table.decimal("ping", 12, 2).nullable();
      table.datetime("started_at").notNullable();
      table.datetime("finished_at").nullable();
    });
};

exports.down = function (knex) {
  return knex.schema
    .dropTable("diagnostic_result")
    .dropTable("diagnostic_run")
    .dropTable("diagnostic_item")
    .dropTable("diagnostic_chain");
};
