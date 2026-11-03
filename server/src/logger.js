'use strict';

const pino = require('pino');
const { env } = require('./config');

const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'mrt-middleware' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['req.headers.authorization', 'req.headers["x-api-key"]', '*.password', '*.apiKey', '*.token'],
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

module.exports = { logger };
