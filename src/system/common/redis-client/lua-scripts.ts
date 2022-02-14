import * as fs from 'fs';
import { ICallback } from '../../../../types';
import { RedisClient } from './redis-client';
import { EmptyCallbackReplyError } from '../errors/empty-callback-reply.error';
import { RedisClientError } from './redis-client.error';
import { waterfall } from '../../lib/async';

export enum ELuaScriptName {
  ZPOPRPUSH,
  LPOPRPUSH,
  ZPOPHGETRPUSH,
  ZPUSHHSET,
  ENQUEUE_SCHEDULED_MESSAGE,
  PUBLISH_MESSAGE,
  REQUEUE_MESSAGE,
  SCHEDULE_MESSAGE,
  RELEASE_LOCK,
  EXTEND_LOCK,
  LPOPRPUSHEXTRA,
}

////

const scriptsMap = new Map<ELuaScriptName, { id?: string; content: string }>();
scriptsMap.set(ELuaScriptName.ZPOPRPUSH, {
  content: fs.readFileSync(`${__dirname}/lua/zpoprpush.lua`).toString(),
});
scriptsMap.set(ELuaScriptName.ZPOPHGETRPUSH, {
  content: fs.readFileSync(`${__dirname}/lua/zpophgetrpush.lua`).toString(),
});
scriptsMap.set(ELuaScriptName.ZPUSHHSET, {
  content: fs.readFileSync(`${__dirname}/lua/zpushhset.lua`).toString(),
});
scriptsMap.set(ELuaScriptName.LPOPRPUSH, {
  content: fs.readFileSync(`${__dirname}/lua/lpoprpush.lua`).toString(),
});
scriptsMap.set(ELuaScriptName.ENQUEUE_SCHEDULED_MESSAGE, {
  content: fs
    .readFileSync(`${__dirname}/lua/enqueue-scheduled-message.lua`)
    .toString(),
});
scriptsMap.set(ELuaScriptName.PUBLISH_MESSAGE, {
  content: fs.readFileSync(`${__dirname}/lua/publish-message.lua`).toString(),
});
scriptsMap.set(ELuaScriptName.REQUEUE_MESSAGE, {
  content: fs.readFileSync(`${__dirname}/lua/requeue-message.lua`).toString(),
});
scriptsMap.set(ELuaScriptName.SCHEDULE_MESSAGE, {
  content: fs.readFileSync(`${__dirname}/lua/schedule-message.lua`).toString(),
});
scriptsMap.set(ELuaScriptName.RELEASE_LOCK, {
  content: fs.readFileSync(`${__dirname}/lua/release-lock.lua`).toString(),
});
scriptsMap.set(ELuaScriptName.EXTEND_LOCK, {
  content: fs.readFileSync(`${__dirname}/lua/extend-lock.lua`).toString(),
});
scriptsMap.set(ELuaScriptName.LPOPRPUSHEXTRA, {
  content: fs.readFileSync(`${__dirname}/lua/lpoprpushextra.lua`).toString(),
});
///

export const loadScripts = (
  redisClient: RedisClient,
  cb: ICallback<void>,
): void => {
  const tasks: ((cb: ICallback<void>) => void)[] = [];
  scriptsMap.forEach((script) =>
    tasks.push((cb: ICallback<void>) =>
      redisClient.loadScript(script.content, (err, sha) => {
        if (err) cb(err);
        else if (!sha) cb(new EmptyCallbackReplyError());
        else {
          script.id = sha;
          cb();
        }
      }),
    ),
  );
  waterfall(tasks, cb);
};

///

export const getScriptId = (name: ELuaScriptName): string => {
  const { id } = scriptsMap.get(name) ?? {};
  if (!id) {
    throw new RedisClientError(`ID of script [${name}] is missing`);
  }
  return id;
};
