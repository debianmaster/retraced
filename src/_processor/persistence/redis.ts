import "source-map-support/register";
import redis from "redis";
import { logger } from "../logger";
import config from '../../config';

const sharedRedisClients = {};

export default function(db) {
  if (!sharedRedisClients[db]) {
      sharedRedisClients[db] = redis.createClient({
          url: config.REDIS_URI,
      });

      sharedRedisClients[db].on("error", (err) => {
          logger.error(err);
          sharedRedisClients[db] = null;
      });
  }

  return sharedRedisClients[db];
}
