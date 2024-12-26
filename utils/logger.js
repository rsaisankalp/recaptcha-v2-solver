const winston = require('winston');

function createLogger(options = {}) {
    const { level = 'info' } = options;

    return winston.createLogger({
        level: level,
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.colorize(),
            winston.format.printf(({ level, message, timestamp }) => {
                return `${timestamp} ${level}: ${message}`;
            })
        ),
        transports: [
            new winston.transports.Console()
        ]
    });
}

module.exports = createLogger; 