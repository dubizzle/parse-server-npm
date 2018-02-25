import PromiseRouter from '../PromiseRouter';
import Config from '../Config';
import Parse from 'parse/node';
import express from 'express';
import _ from 'lodash';
import { logger } from '../logger';
const nr = require('newrelic');
const triggers = require('../triggers');


function parseObject(obj) {
  if (Array.isArray(obj)) {
    return obj.map((item) => {
      return parseObject(item);
    });
  } else if (obj && obj.__type == 'Date') {
    return Object.assign(new Date(obj.iso), obj);
  } else if (obj && obj.__type == 'File') {
    return Parse.File.fromJSON(obj);
  } else if (obj && typeof obj === 'object') {
    return parseParams(obj);
  } else {
    return obj;
  }
}

function parseParams(params) {
  return _.mapValues(params, parseObject);
}

export class WebhooksRouter extends PromiseRouter {

  sendBirdWebhook(req) {
    const appId = Parse.applicationId; // Get the Parse applicationId to access the config
    return this.handleCloudFunction(req, 'sbWebhook', appId);
  }

  static createResponseObject(resolve, reject, message) {
    return {
      success: function(result) {
        resolve({
          response: {
            result: Parse._encode(result)
          }
        });
      },
      error: function(code, message) {
        if (!message) {
          message = code;
          code = Parse.Error.SCRIPT_FAILED;
        }
        reject(new Parse.Error(code, message));
      },
      message: message
    }
  }

  handleCloudFunction(req, functionName, applicationId){
    const config = new Config(applicationId);
    const theFunction = triggers.getFunction(functionName, applicationId);
    const theValidator = triggers.getValidator(functionName, applicationId);
    if (theFunction) {
      let params = Object.assign({}, req.body, req.query);
      params = parseParams(params);
      var request = {
        params: params,
        master: req.auth && req.auth.isMaster,
        user: req.auth && req.auth.user,
        installationId: (req.info) ? req.info.installationId : undefined,
        log: (config) ? config.loggerController : undefined,
        headers: req.headers,
        functionName
      };

      if (theValidator && typeof theValidator === "function") {
        var result = theValidator(request);
        if (!result) {
          throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Validation failed.');
        }
      }

      return new Promise(function (resolve, reject) {
        const userString = (req.auth && req.auth.user) ? req.auth.user.id : undefined;
        const cleanInput = logger.truncateLogMessage(JSON.stringify(params));
        var response = WebhooksRouter.createResponseObject((result) => {
          try {
            // log in newrelic
            nr.addCustomParameters({
              "functionName": functionName,
              "params": cleanInput,
              "user": userString
            });
            const cleanResult = logger.truncateLogMessage(JSON.stringify(result.response.result));
            logger.info(`Ran cloud function ${functionName} for user ${userString} `
              + `with:\n  Input: ${cleanInput }\n  Result: ${cleanResult }`, {
                functionName,
                params,
                user: userString,
              });
            resolve(result);
          } catch (e) {
            reject(e);
          }
        }, (error) => {
          try {
            logger.error(`Failed running cloud function ${functionName} for `
              + `user ${userString} with:\n  Input: ${cleanInput}\n  Error: `
              + JSON.stringify(error), {
                functionName,
                error,
                params,
                user: userString
              });
            reject(error);
          } catch (e) {
            reject(e);
          }
        });
        theFunction(request, response);
      });
    } else {
      throw new Parse.Error(Parse.Error.SCRIPT_FAILED, `Invalid function: "${functionName}"`);
    }
  }

  mountRoutes() {
    this.route('POST','/sendbird',
      req => { return this.sendBirdWebhook(req); });
  }

  expressRouter() {
    const router = express.Router();
    router.use("/", super.expressRouter());
    return router;
  }
}

export default WebhooksRouter;
