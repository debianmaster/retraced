import "source-map-support/register";
import * as chalk from "chalk";
import * as _ from "lodash";
import * as uuid from "uuid";
import * as util from "util";
import * as ProgressBar from "progress";
import * as moment from "moment";

import getElasticsearch, { putAliases } from "../../persistence/elasticsearch";
import { Event } from "../../persistence/EventSource";
import PostgresEventSource from "../../persistence/PostgresEventSource";
import getPgPool from "../../persistence/pg";
import common from "../../common";
import { logger } from "../../../logger";

const pgPool = getPgPool();
const es = getElasticsearch();

export const command = "postgres";
export const desc = "reindex all events from postgres into elasticsearch";

export const builder: any = {
  projectId: {
    alias: "p",
    demand: true,
  },
  environmentId: {
    alias: "e",
    demand: true,
  },
  elasticsearchNodes: {
    demand: true,
  },
  postgresUser: {
    demand: true,
  },
  postgresPort: {
    demand: true,
  },
  postgresDatabase: {
    demand: true,
  },
  postgresHost: {
    demand: true,
  },
  postgresPassword: {
    demand: true,
  },
  pageSize: {
    default: 5000,
  },
  startDate: {
  },
  endDate: {
  },
  dryRun: {
    default: false,
  },
};

export const main = async (argv) => {
  logger.info({msg: "starting handler"});
  let eventSource = new PostgresEventSource(pgPool, argv.startDate, argv.endDate, argv.pageSize);

  const esTempIndex = `retraced.reindex.${uuid.v4()}`;
  const esTargetIndex = `retraced.${argv.projectId}.${argv.environmentId}`;
  const esTargetWriteIndex = `retraced.${argv.projectId}.${argv.environmentId}.current`;

  logger.info({msg: "computed new index names",
    esTempIndex,
    esTargetIndex,
    esTargetWriteIndex,
  });

  const aliasesBlob = await es.cat.aliases({ name: esTargetIndex });
  let currentIndices: any = [];
  aliasesBlob.split("\n").forEach((aliasDesc) => {
    const parts = aliasDesc.split(" ");
    if (parts.length >= 2) {
      currentIndices.push(parts[1]);
    }
  });
  logger.info({msg: "found current read indices",
    count: currentIndices.length,
  });

  const aliasesBlobWrite = await es.cat.aliases({ name: esTargetWriteIndex });
  let currentIndicesWrite: any = [];
  aliasesBlobWrite.split("\n").forEach((aliasDesc) => {
    const parts = aliasDesc.split(" ");
    if (parts.length >= 2) {
      currentIndicesWrite.push(parts[1]);
    }
  });

  logger.info({msg: "found current write indices",
    count: currentIndicesWrite.length,
  });

  await es.indices.create({ index: esTempIndex });

  logger.info({msg: "created temp index",
    esTempIndex,
  });

  let badCount = 0;

  const eachPage = async (result: Event[]) => {
    logger.info(`processing page with count ${result.length}`);
    const pbar = new ProgressBar("[:bar] :percent :etas", {
      incomplete: " ",
      width: 40,
      total: result.length,
    });
    const promises = result.map(async (row: Event) => {
      let actor;
      if (row.actor_id) {
        actor = await common.getActor(row.actor_id);
      }

      let target;
      if (row.object_id) { // -_-
        target = await common.getTarget(row.object_id);
      }

      // postgres you're killing me here with the naming
      const group: any = await common.getGroup(row.team_id);

      // Rename field group_id => id. If the group is from the cache, it may already have been fixed, so we have to check.
      if (group && !group.id) {
        group.id = group.group_id;
        _.unset(group, "group_id");
      }

      let indexableEvent: any = _.pick(row, [
        "id", "description", "action", "crud", "is_failure",
        "is_anonymous", "created", "received", "source_ip",
        "country", "loc_subdiv1", "loc_subdiv2", "raw",
        "canonical_time",
      ]);

      indexableEvent = _.mapValues(indexableEvent, (val, key) => {
        if (key === "created" || key === "received" || key === "canonical_time") {
          return moment(val).valueOf();
        }
        return val;
      });

      indexableEvent.group = _.mapValues(group, (val, key) => {
        if (key === "created_at" || key === "last_active") {
          return moment(val).valueOf();
        }
        if (key === "event_count") {
          return Number(val);
        }
        return val;
      });

      indexableEvent.actor = _.mapValues(actor, (val, key) => {
        if (key === "created"
          || key === "last_active"
          || key === "first_active") {
          return moment(val).valueOf();
        }
        if (key === "event_count") {
          return Number(val);
        }
        return val;
      });

      indexableEvent.target = _.mapValues(target, (val, key) => {
        if (key === "created"
          || key === "last_active"
          || key === "first_active") {
          return moment(val).valueOf();
        }
        if (key === "event_count") {
          return Number(val);
        }
        return val;
      });

      pbar.tick(1);

      return indexableEvent;
    });

    const toBeIndexedDirty = await Promise.all(promises);
    const toBeIndexed = toBeIndexedDirty.filter((o) => o);

    // Bulk index
    pbar.terminate();
    console.log();
    if (_.isEmpty(toBeIndexed)) {
      console.log(chalk.yellow("No valid rows to index!"));
      return;
    }

    const body: any[] = [];
    for (const eventToIndex of toBeIndexed) {
      if (!eventToIndex) {
        continue;
      }

      [eventToIndex.actor, eventToIndex.target].forEach((obj) => {
        if (obj.foreign_id) {
          obj.id = obj.foreign_id;
        }
      });

      body.push({
        index: {
          _index: esTempIndex,
          _type: "event",
        },
      });
      body.push(eventToIndex);
    }

    logger.info(`indexing page with size ${result.length}`);
    await new Promise<void>((resolve, reject) => {
      es.bulk({ body }, (errr, resp, status) => {
        if (errr) {
          console.log(chalk.red(errr.stack));
          process.exit(1);
        }

        if (resp.errors) {
          _.forEach(resp.items, (item) => {
            _.forIn(item, (innerItem) => {
              if (innerItem.error) {
                console.log(chalk.red(util.inspect(innerItem.error)));
                console.log(util.inspect(innerItem.error, false, 100, true));
              }
            });
          });
          console.log(chalk.red("Errors returned by bulk op, unable to continue"));
          process.exit(1);
        }

        logger.info(`finished index`);
        resolve();
      });
    });
  };

  await eventSource.iteratePaged(eachPage);
  logger.info({msg: "finished", esTempIndex, esTargetIndex, currentIndices, esTargetWriteIndex, currentIndicesWrite, badCount });
  finalize({ dryRun: argv.dryRun, esTempIndex, esTargetIndex, currentIndices, esTargetWriteIndex, currentIndicesWrite, badCount });
};

function finalize({ dryRun, esTempIndex, esTargetIndex, currentIndices, esTargetWriteIndex, currentIndicesWrite, badCount}) {

  const toAdd = [{
    index: esTempIndex,
    alias: esTargetIndex,
  }, {
    index: esTempIndex,
    alias: esTargetWriteIndex,
  }];

  const toRemove = currentIndices.map((a) => ({
    index: a,
    alias: esTargetIndex,
  }));

  currentIndicesWrite.forEach((a) => toRemove.push({
    index: a,
    alias: esTargetWriteIndex,
  }));
  logger.info({toAdd, toRemove});

  if (dryRun) {
    console.log(chalk.yellow(`
    
    --dryRun was set, skipping final index rotation.
    
    Index changes for completing the reindex manually are shown above. If you'd like to use these indices, you should:
    
        - remove aliases from the indices listed in toRemove, 
        - add aliases to the indices listed in toAdd`,

    ));
    process.exit(0);
  }

  putAliases(toAdd, toRemove)
    .then(() => {
      console.log("done!");
      if (badCount > 0) {
        console.log(`${badCount} of entries were invalid`);
      }
      console.log(`index: ${esTempIndex}`);
      console.log(`alias: ${esTargetIndex}`);
      if (currentIndices.length > 0) {
        console.log(`note: aliases were removed from the following indices: ${util.inspect(currentIndices)}`);
        console.log(`they can probably be safely deleted now.`);
      }
      process.exit(0);
    })
    .catch((errrr) => {
      throw errrr;
    });
}
