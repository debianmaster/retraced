'use strict';

const validateApiToken = require('./lib/security/validateApiToken');
const createViewerToken = require('./lib/models/viewertoken/create');
const checkAccess = require('./lib/security/checkAccess');

module.exports.default = (event, context, cb) => {
  let apiToken;
  console.log('1');
  validateApiToken(event)
  .then((t) => {
    console.log('2');
    apiToken = t;
    return checkAccess({
      api_token: apiToken,
      project_id: event.path.projectId,
    });
  })
  .then((valid) => {
    if (!valid) {
      cb(new Error('[401] Unauthorized'));
      return;
    }

    console.log('a');
    return createViewerToken({
      project_id: event.path.projectId,
      environment_id: apiToken.environment_id,
      team_id: event.query.team_id,
      format: event.query.output ? event.query.output : 'json',
    });
  })
  .then((viewerToken) => {
    console.log('b');
    const result = {
      token: viewerToken,
    };

    cb(null, result);
    return;
  })
  .catch((err) => {
    cb(err);
  });
};
