/*global module, require, console*/
var Promise = require('bluebird'),
	zipdir = require('../tasks/zipdir'),
	collectFiles = require('../tasks/collect-files'),
	os = require('os'),
	path = require('path'),
	cleanOptionalDependencies = require('../tasks/clean-optional-dependencies'),
	aws = require('aws-sdk'),
	lambdaCode = require('../tasks/lambda-code'),
	shell = require('shelljs'),
	markAlias = require('../tasks/mark-alias'),
	retriableWrap = require('../util/retriable-wrap'),
	rebuildWebApi = require('../tasks/rebuild-web-api'),
	validatePackage = require('../tasks/validate-package'),
	apiGWUrl = require('../util/apigw-url'),
	promiseWrap = require('../util/promise-wrap'),
	NullLogger = require('../util/null-logger'),
	loadConfig = require('../util/loadconfig');
module.exports = function update(options, optionalLogger) {
	'use strict';
	var logger = optionalLogger || new NullLogger(),
		lambda, apiGateway, lambdaConfig, apiConfig, updateResult,
		functionConfig,
		alias = (options && options.version) || 'latest',
		packageDir,
		updateWebApi = function () {
			var apiModule, apiDef, apiModulePath;
			if (apiConfig && apiConfig.id && apiConfig.module) {
				logger.logStage('updating REST API');
				try {
					apiModulePath = path.resolve(path.join(packageDir, apiConfig.module));
					apiModule = require(apiModulePath);
					apiDef = apiModule.apiConfig();
				} catch (e) {
					console.error(e.stack || e);
					return Promise.reject('cannot load api config from ' + apiModulePath);
				}
				updateResult.url = apiGWUrl(apiConfig.id, lambdaConfig.region, alias);
				return rebuildWebApi(lambdaConfig.name, alias, apiConfig.id, apiDef, lambdaConfig.region, logger, options['cache-api-config'])
					.then(function () {
						if (apiModule.postDeploy) {
							return apiModule.postDeploy(
								options,
								{
									name: lambdaConfig.name,
									alias: alias,
									apiId: apiConfig.id,
									apiUrl: updateResult.url,
									region: lambdaConfig.region
								},
								{
									apiGatewayPromise: apiGateway,
									aws: aws,
									Promise: Promise
								}
							);
						}
					}).then(function (postDeployResult) {
						if (postDeployResult) {
							updateResult.deploy = postDeployResult;
						}
					});
			}
		},
		packageArchive,
		cleanup = function () {
			if (!options.keep) {
				shell.rm(packageArchive);
			} else {
				updateResult.archive = packageArchive;
			}
			return updateResult;
		},
		s3Key;
	options = options || {};
	if (!options.source) {
		options.source = shell.pwd();
	}
	if (options.source === os.tmpdir()) {
		return Promise.reject('Source directory is the Node temp directory. Cowardly refusing to fill up disk with recursive copy.');
	}
	if (options['no-optional-dependencies'] && options['use-local-dependencies']) {
		return Promise.reject('incompatible arguments --use-local-dependencies and --no-optional-dependencies');
	}


	logger.logStage('loading Lambda config');
	return loadConfig(options, {lambda: {name: true, region: true}}).then(function (config) {
		lambdaConfig = config.lambda;
		apiConfig = config.api;
		lambda = promiseWrap(new aws.Lambda({region: lambdaConfig.region}), {log: logger.logApiCall, logName: 'lambda'});
		apiGateway = retriableWrap(
				promiseWrap(
					new aws.APIGateway({region: lambdaConfig.region}),
					{log: logger.logApiCall, logName: 'apigateway'}
				),
				function () {
					logger.logStage('rate-limited by AWS, waiting before retry');
				}
		);
	}).then(function () {
		return lambda.getFunctionConfigurationPromise({FunctionName: lambdaConfig.name});
	}).then(function (result) {
		functionConfig = result;
	}).then(function () {
		if (apiConfig) {
			return apiGateway.getRestApiPromise({restApiId: apiConfig.id});
		}
	}).then(function () {
		return collectFiles(options.source, options['use-local-dependencies'], logger);
	}).then(function (dir) {
		logger.logStage('validating package');
		return validatePackage(dir, functionConfig.Handler, apiConfig && apiConfig.module);
	}).then(function (dir) {
		packageDir = dir;
		if (options['no-optional-dependencies']) {
			return cleanOptionalDependencies(dir, logger);
		} else {
			return dir;
		}
	}).then(function (dir) {
		logger.logStage('zipping package');
		return zipdir(dir);
	}).then(function (zipFile) {
		packageArchive = zipFile;
		return lambdaCode(packageArchive, options['use-s3-bucket'], logger);
	}).then(function (functionCode) {
		logger.logStage('updating Lambda');
		s3Key = functionCode.S3Key;
		functionCode.FunctionName = lambdaConfig.name;
		functionCode.Publish = true;
		return lambda.updateFunctionCodePromise(functionCode);
	}).then(function (result) {
		updateResult = result;
		if (s3Key) {
			updateResult.s3key = s3Key;
		}
		return result;
	}).then(function (result) {
		if (options.version) {
			logger.logStage('setting version alias');
			return markAlias(result.FunctionName, lambda, result.Version, options.version);
		}
	}).then(updateWebApi).then(cleanup);
};
module.exports.doc = {
	description: 'Deploy a new version of the Lambda function using project files, update any associated web APIs',
	priority: 2,
	args: [
		{
			argument: 'version',
			optional: true,
			description: 'A version alias to automatically assign to the new deployment',
			example: 'development'
		},
		{
			argument: 'source',
			optional: true,
			description: 'Directory with project files',
			default: 'current directory'
		},
		{
			argument: 'config',
			optional: true,
			description: 'Config file containing the resource names',
			default: 'claudia.json'
		},
		{
			argument: 'no-optional-dependencies',
			optional: true,
			description: 'Do not upload optional dependencies to Lambda.'
		},
		{
			argument: 'use-local-dependencies',
			optional: true,
			description: 'Do not install dependencies, use local node_modules directory instead'
		},
		{
			argument: 'cache-api-config',
			optional: true,
			example: 'claudiaConfigCache',
			description: 'Name of the stage variable for storing the current API configuration signature.\n' +
				'If set, it will also be used to check if the previously deployed configuration can be re-used and speed up deployment'
		},
		{
			argument: 'keep',
			optional: true,
			description: 'keep the produced package archive on disk for troubleshooting purposes.\n' +
				'If not set, the temporary files will be removed after the Lambda function is successfully created'
		},
		{
			argument: 'use-s3-bucket',
			optional: true,
			example: 'claudia-uploads',
			description: 'The name of a S3 bucket that Claudia will use to upload the function code before installing in Lambda.\n' +
				'You can use this to upload large functions over slower connections more reliably, and to leave a binary artifact\n' +
				'after uploads for auditing purposes. If not set, the archive will be uploaded directly to Lambda'
		}
	]
};
