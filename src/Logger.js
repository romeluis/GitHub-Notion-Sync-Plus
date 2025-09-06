class Logger {
    constructor(component = 'App') {
        this.component = component;
    }

    /**
     * Log info message
     * @param {string} message - Message to log
     * @param {*} data - Optional data to log
     */
    info(message, data = null) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${this.component}] INFO: ${message}`);
        if (data) {
            console.log(data);
        }
    }

    /**
     * Log error message
     * @param {string} message - Error message to log
     * @param {Error|*} error - Error object or data
     */
    error(message, error = null) {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] [${this.component}] ERROR: ${message}`);
        if (error) {
            if (error instanceof Error) {
                console.error(error.stack);
            } else {
                console.error(error);
            }
        }
    }

    /**
     * Log warning message
     * @param {string} message - Warning message to log
     * @param {*} data - Optional data to log
     */
    warn(message, data = null) {
        const timestamp = new Date().toISOString();
        console.warn(`[${timestamp}] [${this.component}] WARN: ${message}`);
        if (data) {
            console.warn(data);
        }
    }

    /**
     * Log debug message
     * @param {string} message - Debug message to log
     * @param {*} data - Optional data to log
     */
    debug(message, data = null) {
        if (process.env.DEBUG === 'true') {
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] [${this.component}] DEBUG: ${message}`);
            if (data) {
                console.log(data);
            }
        }
    }
}

module.exports = Logger;
