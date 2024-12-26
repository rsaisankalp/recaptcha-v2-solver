const EventEmitter = require('events');
const generateCaptchaTokensWithAudio = require('./generateCaptchaTokensWithAudio');
const generateCaptchaTokensWithVisual = require('./generateCaptchaTokensWithVisual');
const generateCaptchaTokensWith2Captcha = require('./generateCaptchaTokensWith2Captcha');

// Example usage with all configuration options
const audioExample = async () => {
    const eventEmitter = new EventEmitter();

    eventEmitter.on('tokenGenerated', ({ token }) => {
        console.log('Token:', token);
    });

    await generateCaptchaTokensWithAudio({
        // Core settings
        eventEmitter,
        tokensToGenerate: 3,
        concurrentBrowsers: 1,
        tabsPerBrowser: 1,
        captchaUrl: 'https://www.google.com/recaptcha/api2/demo',

        // Browser settings
        browser: {
            headless: false,
            executablePath: process.platform === 'win32'
                ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
                : '/usr/bin/google-chrome',
            userDataDir: './custom-chrome-data',
            userAgents: [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/123.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 11_0) Chrome/123.0.0.0 Safari/537.36'
            ]
        },

        // Proxy settings
        proxy: {
            enabled: process.env.USE_PROXY === 'true',
            host: process.env.PROXY_HOST,
            port: process.env.PROXY_PORT,
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD
        },

        // Simplified wit.ai configuration
        wit: {
            apiKeys: [
                process.env.WIT_TOKEN,
                process.env.WIT_TOKEN_1,
                process.env.WIT_TOKEN_2
            ]
        }
    });
};

// Example usage for Visual solver with proxy configuration
const visualExample = async () => {
    const eventEmitter = new EventEmitter();

    eventEmitter.on('tokenGenerated', ({ token }) => {
        console.log('Token:', token);
    });

    await generateCaptchaTokensWithVisual({
        // Core settings
        eventEmitter,
        tokensToGenerate: 2,
        concurrentBrowsers: 2,
        tabsPerBrowser: 1,
        captchaUrl: 'https://www.google.com/recaptcha/api2/demo',

        // Browser settings
        browser: {
            headless: false,
            userDataDir: './custom-chrome-data',
            userAgents: [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/123.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 11_0) Chrome/123.0.0.0 Safari/537.36'
            ]
        },

        // Proxy settings
        proxy: {
            enabled: process.env.USE_PROXY === 'true',
            host: process.env.PROXY_HOST,
            port: process.env.PROXY_PORT,
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD
        },

        // Add Gemini configuration
        gemini: {
            apiKey: process.env.GEMINI_API_KEY,
            model: 'gemini-2.0-flash-exp'
        }
    });
};

// Example usage for 2Captcha solver with proxy configuration
const twoCaptchaExample = async () => {
    const eventEmitter = new EventEmitter();

    eventEmitter.on('tokenGenerated', ({ token }) => {
        console.log('Token:', token);
    });

    await generateCaptchaTokensWith2Captcha({
        // Core settings
        eventEmitter,
        tokensToGenerate: 2,
        concurrentBrowsers: 1,
        tabsPerBrowser: 1,
        captchaUrl: 'https://www.google.com/recaptcha/api2/demo',

        // Browser settings
        browser: {
            headless: true,
            userDataDir: './custom-chrome-data',
            userAgents: [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/123.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 11_0) Chrome/123.0.0.0 Safari/537.36'
            ]
        },

        // Proxy settings
        proxy: {
            enabled: process.env.USE_PROXY === 'true',
            host: process.env.PROXY_HOST,
            port: process.env.PROXY_PORT,
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD
        },

        // Update 2captcha configuration name
        "2captcha": {
            apiKey: process.env['2CAPTCHA_API_KEY']
        }
    });
};

// Run any example
if (require.main === module) {
    audioExample().catch(console.error);
}

module.exports = {
    audioExample,
    visualExample,
    twoCaptchaExample
}; 